/**
 * 连通性测试：按卡片草稿向决策端点发一次最小请求，只回「通过 / 原因」。
 *
 * 走 `connection.fetch` 而非 `connection.rpc.handle`：后者求值 `owner.webServer`，
 * 而 connection 不声明 `webServer`。与审查分流：不入降级计数。
 *
 * @module dsh-auto-review-decision/probe
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { baseURLProblem, CREDENTIAL_REF, REVIEW_TIMEOUT_MS, TEST_ROUTE, parseAuthHeader } from './shared/config.ts'
import { byteLength } from './shared/bytes.ts'
import { isRecord } from './shared/tools.ts'
import { budgetState, historyBytes, observe, resetBudget, restoreBudget } from './budget.ts'
import { postDecision, SystemOneCallError } from './systemone-client.ts'
import type { SystemOneRequest } from './systemone.ts'

/** 连通性测试的结果；成功不回细节。 */
export type ProbeResult = {
    readonly ok: true
    /** 响应回报的输入 token 数；端点不回报时缺省。 */
    readonly inputTokens?: number
    /** 实际发送的请求体字节数。 */
    readonly bodyBytes?: number
} | {
    readonly ok: false
    /** 面向用户的失败原因。 */
    readonly message: string
}

/** 最小请求：余额 1152，问是否超过 1000。 */
const PROBE_REQUEST: SystemOneRequest = {
    state: 'The account balance is 1152.',
    questions: {
        balance: {
            type: 'noul',
            instructions: 'Is the balance greater than 1000?',
            criteria: { true: 'The balance exceeds 1000', false: 'The balance does not exceed 1000' },
        },
    },
}

const PLACEHOLDER_SENTENCE = 'This is a placeholder sentence. It is irrelevant and should be ignored.'
const PLACEHOLDER_BYTES = byteLength(PLACEHOLDER_SENTENCE)

/** 路由只认的载荷形状；字段非法一律按缺失处理。 */
interface ProbePayload {
    readonly baseURL: string
    readonly fullURL: boolean
    /** 卡片草稿里的认证头原文。 */
    readonly authHeader: string
    readonly model: string
    /** 卡片草稿里的密钥；空串表示改用已保存的凭据。 */
    readonly apiKey: string
    /** 双发测试的上下文窗口（token）；缺省表示单发最小请求。 */
    readonly contextTokens?: number
}

/** 读出载荷里的字段；类型不符退回空值。 */
function readPayload(payload: unknown): ProbePayload {
    const record = isRecord(payload) ? payload : {}
    const text = (key: string): string => typeof record[key] === 'string' ? record[key] as string : ''
    const tokens = record.contextTokens
    return {
        baseURL: text('baseURL').trim(),
        fullURL: record.fullURL === true,
        authHeader: text('authHeader'),
        model: text('model').trim(),
        apiKey: text('apiKey'),
        contextTokens: typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0 ? tokens : undefined,
    }
}

/** 取失败原因：本模块的错误自带可呈现文案。 */
function messageOf(error: unknown): string {
    if (error instanceof SystemOneCallError) return error.message
    if (error instanceof Error && error.message !== '') return `auto-review: ${error.message}`
    return 'auto-review: 连通性测试失败'
}

/** 解析凭据；未配置返回 undefined。 */
async function resolveKey(ctx: Context): Promise<string | undefined> {
    const credential = await ctx.credentials.resolve(credentialRef(CREDENTIAL_REF))
    return credential?.value
}

/** 校验后的调用参数。 */
interface ProbeCall {
    readonly baseURL: string
    readonly fullURL: boolean
    readonly authHeader: string
    readonly model: string
    readonly apiKey: string
}

/**
 * 校验草稿并解析出调用参数；密钥留空时改用已保存凭据。
 * @returns 调用参数，或校验失败的结果（以 `ok` 字段区分）。
 */
async function resolveCall(ctx: Context, body: ProbePayload): Promise<ProbeCall | ProbeResult> {
    if (body.baseURL === '' || baseURLProblem(body.baseURL) !== undefined) {
        return { ok: false, message: 'auto-review: API 地址未填写或不合法；请检查「API 地址」' }
    }
    const apiKey = body.apiKey || await resolveKey(ctx)
    if (apiKey === undefined || apiKey === '') {
        return { ok: false, message: 'auto-review: 凭据未配置；请检查「API 密钥」' }
    }
    const authHeader = parseAuthHeader(body.authHeader)
    if (authHeader === undefined) {
        return { ok: false, message: 'auto-review: 认证头不合法；请检查「认证头」' }
    }
    return { baseURL: body.baseURL, fullURL: body.fullURL, authHeader, model: body.model, apiKey }
}

/** 单发测试：发一次决策请求并回「通过 / 原因」；`body` 缺省发最小请求。 */
async function singleProbe(call: ProbeCall, signal: AbortSignal, body?: SystemOneRequest): Promise<ProbeResult> {
    const metrics = { bodyBytes: 0 }
    const timeout = AbortSignal.timeout(REVIEW_TIMEOUT_MS)
    try {
        const response = await postDecision(body ?? PROBE_REQUEST, {
            ...call,
            signal: AbortSignal.any([signal, timeout]),
            metrics,
        })
        return { ok: true, inputTokens: response.usage?.input_tokens, bodyBytes: metrics.bodyBytes }
    } catch (error: unknown) {
        return { ok: false, message: messageOf(error) }
    }
}

/** 按占位字节数构造填满上下文的双发请求。 */
function paddedRequest(padBytes: number): SystemOneRequest {
    const repeats = Math.max(0, Math.floor(padBytes / PLACEHOLDER_BYTES))
    return {
        state: { balance: PROBE_REQUEST.state, placeholder: PLACEHOLDER_SENTENCE.repeat(repeats) },
        questions: PROBE_REQUEST.questions,
    }
}

/** 双发测试固定开销的字节数。 */
function fixedBytesOf(call: ProbeCall): number {
    return byteLength(JSON.stringify({
        state: { balance: PROBE_REQUEST.state, placeholder: '' },
        questions: PROBE_REQUEST.questions,
        ...(call.model === '' ? {} : { model: call.model }),
    }))
}

/** 双发测试。 */
async function doubleProbe(body: ProbePayload, call: ProbeCall, signal: AbortSignal): Promise<ProbeResult> {
    const contextTokens = body.contextTokens as number
    // 与正式审查路径同源的观测签名：端点与模型标识的组合。
    const signature = `${call.baseURL}|${String(call.fullURL)}|${call.model}`
    const fixed = fixedBytesOf(call)
    const stash = budgetState()
    resetBudget()
    try {
        const first = await singleProbe(call, signal, paddedRequest(historyBytes(signature, contextTokens, fixed)))
        if (first.ok === false) return first

        const inputTokens = first.inputTokens
        if (inputTokens === undefined || !Number.isFinite(inputTokens)) return { ok: true }

        observe(signature, first.bodyBytes ?? 0, inputTokens)
        const second = await singleProbe(call, signal, paddedRequest(historyBytes(signature, contextTokens, fixed)))
        if (second.ok === false) return { ok: false, message: 'auto-review: 上下文不足' }
        return { ok: true }
    } finally {
        restoreBudget(stash)
    }
}

/**
 * 按草稿配置探活；载荷带 `contextTokens` 时走双发测试，否则发单发最小请求。
 * @returns 通过与否。
 */
async function probe(ctx: Context, payload: unknown, signal: AbortSignal): Promise<ProbeResult> {
    const body = readPayload(payload)
    const call = await resolveCall(ctx, body)
    if ('ok' in call) return call
    if (body.contextTokens === undefined) return singleProbe(call, signal)
    return doubleProbe(body, call, signal)
}

/** 注册连通性测试路由；无连接服务的 profile 下不注册，届时按钮报失败原因。 */
export function installProbeRoute(ctx: Context): void {
    ctx.inject(['connection'], (child) => {
        const connection = child.get('connection') as {
            fetch: { register: (route: unknown) => () => Promise<void> }
        }
        child.effect(function* () {
            const dispose = connection.fetch.register({
                path: TEST_ROUTE,
                methods: ['POST'],
                requestBody: 'buffered',
                fetch: async (request: Request) => {
                    let payload: unknown
                    try {
                        payload = await request.json()
                    } catch {
                        return new Response('invalid json body', { status: 400 })
                    }
                    const result = await probe(ctx, payload, request.signal)
                    return Response.json(result)
                },
            })
            yield dispose
        }, 'auto-review: probe route')
    })
}
