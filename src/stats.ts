/**
 * 审查运行的运行期统计与降级。
 *
 * @module dsh-auto-review-decision/stats
 */

import type { Context } from '@deepseek-ai/cordis'
import { AUTO_PRESET } from '@deepseek-ai/dsh-permission-presets'
import { getReviewConfig } from './config.ts'
import { exitAutoSessions, resolveExitTarget } from './session-exit.ts'
import { CONFIG_NS, FALLBACK_FAILURE_THRESHOLD, NOTICE_ROUTE, STATS_ROUTE } from './shared/config.ts'
import type { ReviewStats } from './shared/stats.ts'

/** 统计入账事件；所有记账都经 {@link updateState}。 */
export type StateEvent =
    | 'review'
    | 'localReview'
    | 'modelReview'
    | 'configError'
    | 'attempt'
    | 'succeeded'
    | 'failed'
    | 'rateLimited'
    | 'calibration'
    | 'factorChange'
    | 'factorFallback'
    | 'verdict'

/** 事件附加观测值；与事件无关的字段忽略。 */
export interface StateData {
    /** 单次请求体字节数。 */
    readonly bodyBytes?: number
    /** 本次尝试从发出到返回的毫秒数。 */
    readonly durationMs?: number
    /** 成功响应回报的输入 token 数；缺失或非法时不入账。 */
    readonly inputTokens?: number
    /** 失败是否由调用方中止；中止不计连续失败。 */
    readonly aborted?: boolean
    /** 是否 429 重试尝试；仅 `attempt` 使用。 */
    readonly retry?: boolean
    /** 更新后的当前因子；仅 `factorChange` 使用。 */
    readonly factor?: number
    /** 审查结论；仅拒绝与询问计入。 */
    readonly verdict?: 'allow' | 'deny' | 'ask'
}

/** 全局状态。 */
let stats : ReviewStats

/** 重置换新对象，避免残留可缺省字段。 */
function emptyStats(): void {
    stats = {
        reviewCount: 0,
        localReviews: 0,
        modelReviews: 0,
        configErrors: 0,
        requests: 0,
        retries: 0,
        succeeded: 0,
        failed: 0,
        rateLimited: 0,
        denied: 0,
        asked: 0,
        calibrations: 0,
        fallbacks: 0,
        factorFallbacks: 0,
        consecutiveFailures: 0,
        degraded: false,
        sentBytes: 0,
        inputTokens: 0,
        totalMs: 0,
        averageMs: 0,
    }
}

/** 有效 token 数。 */
function validTokens(value: number | undefined): number | undefined {
    return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined
}

/** 记录一次尝试结局的耗时与最近字节。 */
function recordOutcome(data: StateData): void {
    stats.totalMs += data.durationMs ?? 0
    stats.averageMs = stats.requests === 0 ? 0 : stats.totalMs / stats.requests
    stats.lastBytes = data.bodyBytes ?? 0
}

/** 清掉上一次成功留下的 token 与单次因子。 */
function clearTokens(): void {
    delete stats.lastTokens
    delete stats.lastFactor
}

/** 记录成功响应的 token 与单次因子；缺失或非法时清掉上次残留。 */
function recordTokens(data: StateData): void {
    const tokens = validTokens(data.inputTokens)
    if (tokens === undefined) {
        clearTokens()
        return
    }
    stats.inputTokens += tokens
    stats.lastTokens = tokens
    stats.lastFactor = (data.bodyBytes ?? 0) / tokens
}

/** 记一次连续失败；达阈值时置降级标记并执行一次降级动作。 */
function countFailure(at: number): void {
    stats.consecutiveFailures++
    if (stats.consecutiveFailures < FALLBACK_FAILURE_THRESHOLD || stats.degraded) return
    stats.degraded = true
    stats.fallbacks++
    stats.lastFallbackAt = at
    triggerFallback()
}

/**
 * 唯一记账入口：计数、时间戳、连续失败与降级触发都在此处同点更新。
 *
 * @param event - 本次要入账的动作。
 * @param data - 事件附带的字节、token、耗时等观测值。
 */
export function updateState(event: StateEvent, data: StateData = {}): void {
    const at = Date.now()
    switch (event) {
        case 'review':
            stats.reviewCount++
            return
        case 'localReview':
            stats.localReviews++
            return
        case 'modelReview':
            stats.modelReviews++
            return
        case 'configError':
            stats.configErrors++
            countFailure(at)
            return
        case 'attempt':
            stats.requests++
            if (data.retry === true) stats.retries++
            stats.sentBytes += data.bodyBytes ?? 0
            return
        case 'succeeded':
            stats.succeeded++
            stats.lastSuccessAt = at
            recordOutcome(data)
            recordTokens(data)
            stats.consecutiveFailures = 0
            return
        case 'failed':
            stats.failed++
            stats.lastFailureAt = at
            recordOutcome(data)
            clearTokens()
            if (data.aborted !== true) countFailure(at)
            return
        case 'rateLimited':
            stats.rateLimited++
            stats.lastFailureAt = at
            recordOutcome(data)
            clearTokens()
            // 429 说明端点可用、仅被限流。
            stats.consecutiveFailures = 0
            return
        case 'calibration':
            stats.calibrations++
            return
        case 'factorChange':
            if (data.factor !== undefined && Number.isFinite(data.factor)) stats.factor = data.factor
            return
        case 'factorFallback':
            stats.factorFallbacks++
            return
        case 'verdict':
            if (data.verdict === 'deny') stats.denied++
            else if (data.verdict === 'ask') stats.asked++
    }
}

/** 当前统计快照：只做组装与返回，口径在记账时保证。 */
export function reviewStats(): ReviewStats {
    return { ...stats }
}

/** 只清 fallback 状态：连续失败与降级标记；面板累计值保持不动。 */
export function resetFallbackState(clear = true): void {
    stats.consecutiveFailures = 0
    if (clear) stats.degraded = false
}

/** 提示广播器：登记浏览器订阅者，插件卸载时全部关闭。 */
class NoticeBroadcaster {
    private readonly subscribers = new Set<(event: string) => void>()

    /** 发布一条提示。 */
    publish(event: string): void {
        for (const subscriber of [...this.subscribers]) subscriber(event)
    }

    /**
     * 登记一个订阅者。
     * @param subscriber - 接收提示的回调。
     * @returns 注销函数。
     */
    subscribe(subscriber: (event: string) => void): () => void {
        this.subscribers.add(subscriber)
        return () => { this.subscribers.delete(subscriber) }
    }

    /** 关闭全部订阅者。 */
    close(): void {
        this.subscribers.clear()
    }
}

/**
 * 注册提示路由。没有连接服务的 profile 下不注册，降级仍生效，只是不弹提示。
 * @param ctx - 宿主上下文。
 * @param broadcaster - 提示广播器。
 */
function installNoticeRoute(ctx: Context, broadcaster: NoticeBroadcaster): void {
    ctx.inject(['connection'], (child) => {
        const connection = child.get('connection') as {
            fetch: { register: (route: unknown) => () => Promise<void> }
        }
        child.effect(function* () {
            const dispose = connection.fetch.register({
                path: NOTICE_ROUTE,
                methods: ['GET'],
                requestBody: 'buffered',
                fetch: async (request: Request) => {
                    const encoder = new TextEncoder()
                    const stream = new ReadableStream<Uint8Array>({
                        start(controller) {
                            const unsubscribe = broadcaster.subscribe((event) => {
                                try {
                                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
                                } catch {
                                }
                            })
                            request.signal.addEventListener('abort', () => {
                                unsubscribe()
                                try {
                                    controller.close()
                                } catch {
                                }
                            }, { once: true })
                        },
                    })
                    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
                },
            })
            yield dispose
        }, 'auto-review: notice route')
    })
}

/** 全局提示广播器与降级上下文；由 {@link applyFallback} 初始化、卸载时清空。 */
let broadcaster: NoticeBroadcaster | undefined
let fallbackCtx: Context | undefined

/** 执行一次降级：按当前配置解析目标预设、切走所有 Auto 会话并按配置推送提示。 */
function triggerFallback(): void {
    const ctx = fallbackCtx
    if (ctx === undefined) return
    const preset = resolveExitTarget(ctx, getReviewConfig().values.onApiUnavailable)
    exitAutoSessions(ctx, preset)
    if (getReviewConfig().values.notifyOnFallback) broadcaster?.publish(preset)
}

/**
 * 安装降级设施：登记提示广播器与路由、监听 fallback 状态复位，卸载时关闭推送并清掉全局引用。
 * @param ctx - 宿主上下文。
 */
export function applyFallback(ctx: Context): void {
    emptyStats()
    resetFallbackState()
    fallbackCtx = ctx
    broadcaster = new NoticeBroadcaster()
    installNoticeRoute(ctx, broadcaster)
    installStatsRoute(ctx)
    ctx.effect(function* () {
        // 重新选择 Auto 即恢复可用：只清连续失败与降级标记，面板累计不动。
        const stopAuto = ctx.on('session/event', (_session, event) => {
            if (event.type !== 'permission/preset' || event.data.preset !== AUTO_PRESET) return
            resetFallbackState()
        })
        yield stopAuto
        // 配置更新沿用旧行为：只清连续失败，降级标记在同一装载内保留。
        const stopConfig = ctx.on('settings/document-updated', (ns) => {
            if (ns === CONFIG_NS) resetFallbackState(false)
        })
        yield stopConfig
        yield () => {
            broadcaster?.close()
            fallbackCtx = undefined
            broadcaster = undefined
        }
    }, 'auto-review: fallback')
}

/** 注册只读统计路由；无连接服务的 profile 下不注册，卡片读不到数据。 */
function installStatsRoute(ctx: Context): void {
    ctx.inject(['connection'], (child) => {
        const connection = child.get('connection') as {
            fetch: { register: (route: unknown) => () => Promise<void> }
        }
        child.effect(function* () {
            const dispose = connection.fetch.register({
                path: STATS_ROUTE,
                methods: ['GET'],
                requestBody: 'buffered',
                fetch: async () => Response.json(reviewStats()),
            })
            yield dispose
        }, 'auto-review: stats route')
    })
}
