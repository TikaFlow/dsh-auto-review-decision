/**
 * SystemOne 决策接口的：失败即抛；429 时退避重试。
 *
 * @module dsh-auto-review-decision/systemone-client
 */

import { REVIEW_TIMEOUT_MS, SCORE_LEVELS, decisionEndpoint } from './shared/config.ts'
import { byteLength } from './shared/bytes.ts'
import { isRecord } from './shared/tools.ts'
import type {
    SystemOneAnswer,
    SystemOneQuestion,
    SystemOneQuestions,
    SystemOneRequest,
    SystemOneResponse,
    SystemOneErrorResponse,
} from './systemone.ts'

/** 一次调用失败的归类：取值即机器可读的类别，修正项由 {@link FAILURE_FIX} 给出。 */
export const FAILURE = {
    /** 配置不完整：地址缺失或凭据未配置。 */
    config: 'config',
    /** 请求超时。 */
    timeout: 'timeout',
    /** 调用方中止。 */
    aborted: 'aborted',
    /** 网络不可达。 */
    network: 'network',
    /** 接口返回非 200。 */
    status: 'status',
    /** 响应不是合法 JSON 对象。 */
    parse: 'parse',
    /** 响应缺少字段或结构不符。 */
    field: 'field',
    /** 取值越界。 */
    range: 'range',
} as const

/** 一次调用失败的归类。 */
export type SystemOneFailureKind = (typeof FAILURE)[keyof typeof FAILURE]

/** 每类失败对应需要修正的配置项。 */
export const FAILURE_FIX: Readonly<Record<SystemOneFailureKind, string>> = {
    config: 'API 地址、API 密钥',
    timeout: 'API 地址',
    aborted: '',
    network: 'API 地址',
    status: 'API 地址、模型 ID',
    parse: 'API 地址',
    field: '模型 ID',
    range: '模型 ID',
}

/** 一次决策调用的失败；`message` 可直接呈现给调用方。 */
export class SystemOneCallError extends Error {
    /** 失败归类。 */
    readonly kind: SystemOneFailureKind

    /** 已收到的 HTTP 状态码；未收到响应或 200 后校验失败时为 `undefined`。 */
    readonly status: number | undefined

    constructor(
        kind: SystemOneFailureKind,
        detail: string,
        status?: number,
    ) {
        const fix = FAILURE_FIX[kind]
        super(`auto-review: ${detail}${fix === '' ? '' : `；请检查「${fix}」`}`)
        this.name = 'SystemOneCallError'
        this.kind = kind
        this.status = status
    }
}

/** 错误摘要的字符上限。 */
const MAX_DETAIL = 200

/** 429 重试尝试的超时（毫秒）：端点已证明可达，按推理时长的容忍度而非网络不可达的 30 秒。 */
const RETRY_TIMEOUT_MS = 10_000

/** 调用一次决策接口所需的参数。 */
export interface DecisionCallOptions {
    /** 已校验的端点基址。 */
    readonly baseURL: string
    /** 基址是否已含完整路径；为真时不追加 `/systemone`。 */
    readonly fullURL: boolean
    /** 已归一的认证头取值。 */
    readonly authHeader: string
    /** 决策模型标识；留空则不发送该字段。 */
    readonly model: string
    /** 凭据解析得到的密钥。 */
    readonly apiKey: string
    /** 调用方生命周期；中止即在途中断。 */
    readonly signal: AbortSignal
    /** 注入的 fetch，默认取全局实现。 */
    readonly fetchImpl?: typeof fetch
    /** 观测出口：实际发送的请求体字节数在序列化后回填。 */
    readonly metrics?: { bodyBytes: number }
}

/** 从非 200 的响应体里摘出简短摘要，不含响应原文。 */
function statusDetail(body: string): string {
    const trimmed = body.trim()
    if (trimmed === '') return ''
    let parsed: SystemOneErrorResponse
    try {
        parsed = JSON.parse(trimmed) as SystemOneErrorResponse
    } catch {
        return ''
    }
    if (!isRecord(parsed)) return ''
    const parts: string[] = []
    const error = parsed.error
    if (typeof error === 'string') parts.push(error)
    else if (isRecord(error)) {
        if (typeof error.message === 'string') parts.push(error.message)
        if (typeof error.type === 'string') parts.push(error.type)
        if (typeof error.code === 'string') parts.push(error.code)
        else if (typeof error.code === 'number') parts.push(String(error.code))
    }
    if (typeof parsed.message === 'string') parts.push(parsed.message)
    if (typeof parsed.code === 'string') parts.push(parsed.code)
    else if (typeof parsed.code === 'number') parts.push(String(parsed.code))
    return parts.join(' / ').slice(0, MAX_DETAIL)
}

/** 校验一条答案的数值字段越界与否。 */
function checkAnswer(id: string, question: SystemOneQuestion, answer: SystemOneAnswer): void {
    if (answer.type !== question.type) {
        throw new SystemOneCallError(FAILURE.field, `问题 "${id}" 的答案类型应为 ${question.type}，实为 ${answer.type}`)
    }
    if (answer.type === 'noul') {
        if (!Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
            throw new SystemOneCallError(FAILURE.range, `问题 "${id}" 的 noul 取值越界（应在 0–1）`)
        }
    } else if (answer.type === 'score') {
        const top = SCORE_LEVELS - 1
        if (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > top) {
            throw new SystemOneCallError(FAILURE.range, `问题 "${id}" 的 score 取值越界（应在 0–${top}）`)
        }
    }
    const probabilities = 'probabilities' in answer ? answer.probabilities : undefined
    if (probabilities !== undefined) {
        for (const [key, value] of Object.entries(probabilities)) {
            if (!Number.isFinite(value) || value < 0) {
                throw new SystemOneCallError(FAILURE.range, `问题 "${id}" 的 probabilities["${key}"] 不是非负有限数`)
            }
        }
    }
}

/**
 * 校验响应结构：答案表齐备、类型一致、取值在界内。不 clamp。
 * @param questions - 本次请求的问题表。
 * @param response - 已解析的响应体。
 */
export function validateDecisionResponse(
    questions: SystemOneQuestions,
    response: SystemOneResponse,
): void {
    if (!isRecord(response.answers)) {
        throw new SystemOneCallError(FAILURE.field, '响应缺少 answers，端点可能不是 SystemOne')
    }
    for (const id of Object.keys(questions)) {
        const answer = response.answers[id]
        if (answer === undefined) {
            throw new SystemOneCallError(FAILURE.field, `响应缺少问题 "${id}" 的答案，模型可能不支持本插件的问题表`)
        }
        if (!isRecord(answer) || typeof answer.type !== 'string') {
            throw new SystemOneCallError(FAILURE.field, `问题 "${id}" 的答案结构不合法`)
        }
        checkAnswer(id, questions[id] as SystemOneQuestion, answer as unknown as SystemOneAnswer)
    }
}

/** Node 的 fetch 在超时与中止时抛出的错误名。 */
const TIMEOUT_ERROR = 'TimeoutError'
const ABORT_ERROR = 'AbortError'

/** 把一次网络失败归类成超时、中止或网络错误。 */
function networkError(error: unknown, signal: AbortSignal, timeout: AbortSignal, timeoutMs: number): SystemOneCallError {
    const name = error instanceof Error ? error.name : ''
    const timedOut = timeout.aborted || name === TIMEOUT_ERROR
    const aborted = signal.aborted || name === ABORT_ERROR
    if (timedOut && !aborted) {
        return new SystemOneCallError(FAILURE.timeout, `决策请求超时（${String(timeoutMs / 1000)} 秒）`)
    }
    if (aborted) {
        return new SystemOneCallError(FAILURE.aborted, '决策请求被中止')
    }
    const reason = error instanceof Error ? error.message : String(error)
    return new SystemOneCallError(FAILURE.network, `决策请求网络失败：${reason}`)
}

/** 读取响应体；读取中断同样按上述规则归类。 */
async function readText(response: Response, signal: AbortSignal, timeout: AbortSignal, timeoutMs: number): Promise<string> {
    try {
        return await response.text()
    } catch (error: unknown) {
        throw networkError(error, signal, timeout, timeoutMs)
    }
}

/** 一次 HTTP 429 响应：唯一的可重试失败；重试耗尽后原样抛出。 */
class RateLimitedError extends SystemOneCallError {
    constructor(detail: string) {
        super(FAILURE.status, detail, 429)
        this.name = 'RateLimitedError'
    }
}

/** 等待期间被中止的失败归类：超时信号按超时上报，其余按中止。 */
function waitAborted(signal: AbortSignal): SystemOneCallError {
    return signal.reason instanceof Error && signal.reason.name === TIMEOUT_ERROR
        ? new SystemOneCallError(FAILURE.timeout, `决策请求超时（${String(REVIEW_TIMEOUT_MS / 1000)} 秒）`)
        : new SystemOneCallError(FAILURE.aborted, '决策请求被中止')
}

/** 可被中止的退避等待；已中止则不进入等待。 */
function backoffSleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(waitAborted(signal))
    return new Promise((resolve, reject) => {
        const onAbort = (): void => {
            clearTimeout(timer)
            reject(waitAborted(signal))
        }
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        signal.addEventListener('abort', onAbort, { once: true })
    })
}

/** 单次尝试的固定输入：序列化后的请求体、fetch 实现与请求头。 */
interface AttemptContext {
    readonly serialized: string
    readonly fetchImpl: typeof fetch
    readonly headers: Headers
}

/** 发出一次请求并校验响应；失败即抛，429 以 RateLimitedError 标记。 */
async function attemptDecision(
    request: SystemOneRequest,
    options: DecisionCallOptions,
    ctx: AttemptContext,
    timeoutMs: number,
): Promise<SystemOneResponse> {
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = AbortSignal.any([options.signal, timeout])
    let response: Response
    try {
        response = await ctx.fetchImpl(decisionEndpoint(options.baseURL, options.fullURL), {
            method: 'POST',
            headers: ctx.headers,
            body: ctx.serialized,
            signal: combined,
        })
    } catch (error: unknown) {
        throw networkError(error, options.signal, timeout, timeoutMs)
    }

    const text = await readText(response, options.signal, timeout, timeoutMs)
    if (!response.ok) {
        const detail = statusDetail(text)
        const message = `决策接口返回 HTTP ${String(response.status)}${detail === '' ? '' : `：${detail}`}`
        throw response.status === 429 ? new RateLimitedError(message) : new SystemOneCallError(FAILURE.status, message, response.status)
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        throw new SystemOneCallError(FAILURE.parse, '决策响应不是合法 JSON')
    }
    if (!isRecord(parsed)) {
        throw new SystemOneCallError(FAILURE.parse, '决策响应不是对象')
    }
    const payload = isRecord(parsed.result) ? parsed.result : parsed
    const result = payload as unknown as SystemOneResponse
    validateDecisionResponse(request.questions, result)
    return result
}

/**
 * 发出一次决策请求并校验响应。不排队、不合并；HTTP 429 时退避重试至多 `retries` 次。
 * 首次尝试使用 {@link REVIEW_TIMEOUT_MS}，重试尝试使用 {@link RETRY_TIMEOUT_MS}。
 * 
 * @param request - 请求体；`model` 为空时不发送该字段。
 * @param options - 端点、模型、密钥、生命周期与注入点。
 * @param retries - 429 的重试次数；0 表示不重试（探活路径使用）。
 * @returns 已校验的响应体。
 * @throws {SystemOneCallError} 凭据缺失、超时、中止、网络失败、非 200、解析失败、字段缺失或取值越界。
 */
export async function postDecisionWithRetry(
    request: SystemOneRequest,
    options: DecisionCallOptions,
    retries: number = 5,
): Promise<SystemOneResponse> {
    if (options.apiKey === '') {
        throw new SystemOneCallError(FAILURE.config, '凭据未配置')
    }
    const body: Record<string, unknown> = { state: request.state, questions: request.questions }
    const model = request.model || options.model
    if (model) body.model = model
    // 与实际发送体同源计量，避免调用方二次序列化产生偏差。
    const serialized = JSON.stringify(body)
    if (options.metrics !== undefined) options.metrics.bodyBytes = byteLength(serialized)

    const headers = new Headers({ 'Content-Type': 'application/json' })
    const replace = options.authHeader.startsWith('!')
    const name = replace ? options.authHeader.slice(1) : options.authHeader
    if (replace) headers.delete('Authorization')
    else headers.set('Authorization', `Bearer ${options.apiKey}`)
    if (name !== '' && !headers.has(name)) headers.set(name, options.apiKey)

    const ctx: AttemptContext = { serialized, fetchImpl: options.fetchImpl ?? fetch, headers }
    let delay = 1000
    for (let attempt = 0; ; attempt++) {
        try {
            const timeoutMs = attempt === 0 ? REVIEW_TIMEOUT_MS : RETRY_TIMEOUT_MS
            return await attemptDecision(request, options, ctx, timeoutMs)
        } catch (error: unknown) {
            // 仅 429 重试；重试中遇到任何非 429 也立即抛出。
            if (!(error instanceof RateLimitedError) || attempt >= retries) throw error
            await backoffSleep(delay, options.signal)
            delay *= 2
        }
    }
}
