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
import {
    baseURLProblem,
    CREDENTIAL_REF,
    PROBE_TIMEOUT_MS,
    TEST_ROUTE,
    isContextTokensInRange,
    parseAuthHeader,
    type ProbeFailureCode,
} from './shared/config.ts'
import { byteLength } from './shared/bytes.ts'
import { isRecord } from './shared/tools.ts'
import { historyBytes } from './budget.ts'
import { FAILURE, postDecisionWithRetry, SystemOneCallError } from './systemone-client.ts'
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
    /** 插件侧失败码；卡片据此取本地化文案。 */
    readonly code?: ProbeFailureCode
    /** 动态诊断原文。 */
    readonly message?: string
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
    /** 双发测试的上下文窗口（token）；缺省表示单发最小请求，越界按载荷非法。 */
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
        contextTokens: typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : undefined,
    }
}

/** 取失败原因：SystemOne 错误自带诊断详情，其余按插件侧失败码归类。 */
function messageOf(error: unknown): ProbeResult {
    if (error instanceof SystemOneCallError) return { ok: false, message: error.message }
    if (error instanceof Error && error.message !== '') return { ok: false, message: error.message }
    return { ok: false, code: 'probeFailed' }
}

function doubleFailureOf(error: unknown): ProbeResult {
    if (error instanceof SystemOneCallError) {
        if (error.status === 429) return { ok: false, code: 'rateLimited' }
        if (error.kind === FAILURE.timeout || error.kind === FAILURE.network) return { ok: false, code: 'networkFailed' }
    }
    return { ok: false, code: 'unknownFailure' }
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
 * 校验草稿并解析出调用参数；密钥留空时改用已保存凭据，仍为空则以 `public` 占位发送。
 * @returns 调用参数，或校验失败的结果（以 `ok` 字段区分）。
 */
async function resolveCall(ctx: Context, body: ProbePayload): Promise<ProbeCall | ProbeResult> {
    if (body.baseURL === '' || baseURLProblem(body.baseURL) !== undefined) {
        return { ok: false, code: 'baseURLInvalid' }
    }
    const apiKey = body.apiKey || await resolveKey(ctx) || ''
    const authHeader = parseAuthHeader(body.authHeader)
    if (authHeader === undefined) {
        return { ok: false, code: 'authHeaderInvalid' }
    }
    return { baseURL: body.baseURL, fullURL: body.fullURL, authHeader, model: body.model, apiKey }
}

/** 单发测试：发一次决策请求并回「通过 / 原因」；`body` 缺省发最小请求。 */
async function singleProbe(
    call: ProbeCall,
    signal: AbortSignal,
    body?: SystemOneRequest,
    failOf: (error: unknown) => ProbeResult = messageOf,
): Promise<ProbeResult> {
    const metrics = { bodyBytes: 0 }
    const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS)
    try {
        const response = await postDecisionWithRetry(body ?? PROBE_REQUEST, {
            ...call,
            signal: AbortSignal.any([signal, timeout]),
            metrics,
        }, 0)
        return { ok: true, inputTokens: response.usage?.input_tokens, bodyBytes: metrics.bodyBytes }
    } catch (error: unknown) {
        return failOf(error)
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
async function doubleProbe(contextTokens: number, call: ProbeCall, signal: AbortSignal): Promise<ProbeResult> {
    const fixed = fixedBytesOf(call)
    let factor = 2.5
    const first = await singleProbe(call, signal, paddedRequest(historyBytes('', contextTokens, fixed, factor)))
    if (first.ok === false) return first

    const bodyBytes = first.bodyBytes ?? 0
    const inputTokens = first.inputTokens
    if (inputTokens === undefined
        || !Number.isFinite(inputTokens)
        || !Number.isFinite(bodyBytes)
        || bodyBytes <= 0
        || inputTokens <= 0) return { ok: true }

    factor = bodyBytes / inputTokens
    const second = await singleProbe(call, signal, paddedRequest(historyBytes('', contextTokens, fixed, factor)), doubleFailureOf)
    if (second.ok === false) return second
    return { ok: true }
}

/**
 * 按草稿配置探活；载荷带合法 `contextTokens` 时走双发测试，缺省发单发最小请求。
 * @returns 通过与否。
 */
async function probe(ctx: Context, payload: unknown, signal: AbortSignal): Promise<ProbeResult> {
    const body = readPayload(payload)
    const call = await resolveCall(ctx, body)
    if ('ok' in call) return call
    const contextTokens = body.contextTokens
    if (contextTokens === undefined) return singleProbe(call, signal)
    if (!isContextTokensInRange(contextTokens)) {
        return { ok: false, code: 'invalidResponse' }
    }
    return doubleProbe(contextTokens, call, signal)
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
                        return Response.json({ ok: false, code: 'invalidResponse' })
                    }
                    const result = await probe(ctx, payload, request.signal)
                    return Response.json(result)
                },
            })
            yield dispose
        }, 'auto-review: probe route')
    })
}
