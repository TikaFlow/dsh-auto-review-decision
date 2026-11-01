/**
 * 连续失败降级：全局累计审查失败，达阈值后降级并把所有 Auto 会话切走。
 *
 * 计数与降级都发生在审查调用内部，宿主生命周期无需感知。
 *
 * @module dsh-auto-review-decision/fallback
 */

import type { Context } from '@deepseek-ai/cordis'
import { AUTO_PRESET } from '@deepseek-ai/dsh-permission-presets'
import { getReviewConfig } from './config.ts'
import { exitAutoSessions } from './session-exit.ts'
import { CONFIG_NS, FALLBACK_FAILURE_THRESHOLD, NOTICE_ROUTE } from './shared/config.ts'
import { SystemOneCallError } from './systemone-client.ts'

/** 计入降级的失败类别：决策端点不可用。 */
const COUNTED = new Set<string>(['config', 'timeout', 'network', 'status', 'parse', 'field', 'range'])

/** 一条提示事件。 */
interface NoticeEvent {
    /** 该次降级切到的权限预设名。 */
    readonly preset: string
}

/** 提示广播器：登记浏览器订阅者，插件卸载时全部关闭。 */
class NoticeBroadcaster {
    private readonly subscribers = new Set<(event: NoticeEvent) => void>()

    /** 发布一条提示。 */
    publish(event: NoticeEvent): void {
        for (const subscriber of [...this.subscribers]) subscriber(event)
    }

    /**
     * 登记一个订阅者。
     * @param subscriber - 接收提示的回调。
     * @returns 注销函数。
     */
    subscribe(subscriber: (event: NoticeEvent) => void): () => void {
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

/** 全局提示广播器与守卫；由 {@link applyFallback} 初始化、卸载时清空。 */
let broadcaster: NoticeBroadcaster | undefined
let guard: FallbackGuard | undefined

/** 全局连续失败计数器与降级动作。 */
export class FallbackGuard {
    private failures = 0
    private degraded = false

    /**
     * @param ctx - 宿主上下文，用于切走会话预设。
     * @param target - 每次降级时读取的目标权限预设。
     * @param notify - 每次降级时读取的是否提示用户。
     * @param publish - 降级提示的出口。
     */
    constructor(
        private readonly ctx: Context,
        private readonly target: () => string,
        private readonly notify: () => boolean,
        private readonly publish: (preset: string) => void,
    ) { }

    /** 一次审查成功后清零。 */
    succeeded(): void {
        this.failures = 0
    }

    /** 一次审查失败后计数，达阈值则降级并按配置提示。 */
    failed(error: unknown): void {
        if (!isCountedFailure(error)) return
        this.failures += 1
        if (this.failures < FALLBACK_FAILURE_THRESHOLD || this.degraded) return
        this.degraded = true
        const preset = this.target()
        exitAutoSessions(this.ctx, preset)
        if (this.notify()) this.publish(preset)
    }

    /** 重新选择 Auto 时清零计数与降级标记。 */
    reset(): void {
        this.failures = 0
        this.degraded = false
    }
}

/** 判断一次审查失败是否计入连续失败。 */
function isCountedFailure(error: unknown): boolean {
    return error instanceof SystemOneCallError && COUNTED.has(error.kind)
}

/**
 * 安装降级设施：创建守卫与提示广播器、注册提示路由、监听重新选择 Auto 的清零事件；
 * 卸载时关闭提示推送并清掉全局引用。
 * @param ctx - 宿主上下文。
 */
export function applyFallback(ctx: Context): void {
    broadcaster = new NoticeBroadcaster()
    installNoticeRoute(ctx, broadcaster)
    guard = new FallbackGuard(
        ctx,
        () => getReviewConfig().values.onApiUnavailable,
        () => getReviewConfig().values.notifyOnFallback,
        (preset) => { broadcaster?.publish({ preset }) },
    )
    ctx.effect(function* () {
        // 重新选择 Auto 时清零全局连续失败计数与降级标记。
        const stopReset = ctx.on('session/event', (_session, event) => {
            if (event.type !== 'permission/preset' || event.data.preset !== AUTO_PRESET) return
            guard?.reset()
        })
        yield stopReset
        const stopConfig = ctx.on('settings/document-updated', (ns) => (ns === CONFIG_NS) && guard?.succeeded())
        yield stopConfig
        yield () => {
            broadcaster?.close()
            broadcaster = undefined
            guard = undefined
        }
    }, 'auto-review: fallback')
}

/** 取全局守卫；未安装时返回 undefined。 */
export function getGuard(): FallbackGuard | undefined {
    return guard
}
