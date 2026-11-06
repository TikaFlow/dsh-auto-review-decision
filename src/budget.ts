/**
 * 审查预算的自校准：由历史请求的字节数与返回 token 数推算 token 因子，据此给出本次可用的字节上限。
 *
 * 状态跨请求累计；决策端点或模型标识变化即整体重置，使因子始终对应当前端点。
 *
 * @module dsh-auto-review-decision/budget
 */

/** 压线余量的比例。 */
const CONTEXT_MARGIN_RATIO = 0.05

/** 压线余量的下限（token），供小上下文使用。 */
const MIN_CONTEXT_MARGIN_TOKENS = 1024

/** token 因子的初始值：每个 token 平均对应的字节数。 */
const INITIAL_TOKEN_FACTOR = 2.5

/** 收到非 200/429 的 HTTP 响应时，因子每次回退的步长。 */
const FALLBACK_STEP = 0.25

/** 因子回退的下限。 */
const MIN_TOKEN_FACTOR = 1.25

/** 累计量：只统计「字节数与 token 数都拿到」的请求，两侧必须同源配对。 */
interface Ledger {
    /** 观测签名；变化即重置。 */
    signature: string
    /** 累计发送字节数。 */
    totalBytes: number
    /** 累计返回 token 数。 */
    totalTokens: number
    /** 当前 token 因子：每 token 平均字节数。 */
    factor: number
}

/** 全局账本；插件卸载后重新开始。 */
let ledger: Ledger | undefined

/** 把账本重置到初始状态并绑定签名。 */
function reset(signature: string): Ledger {
    ledger = {
        signature,
        totalBytes: 0,
        totalTokens: 0,
        factor: INITIAL_TOKEN_FACTOR,
    }
    return ledger
}

/** 取签名对应的账本；签名不同则重置。 */
function ledgerFor(signature: string): Ledger {
    if (ledger === undefined || ledger.signature !== signature) return reset(signature)
    return ledger
}

/**
 * 本次留给可裁剪历史的字节数：整份内容的字节上限扣掉固定开销。
 *
 * @param signature - 决策端点与模型标识的组合，变化即重置。
 * @param contextTokens - 决策模型上下文窗口（token）。
 * @param fixedBytes - 固定开销的字节数。
 * @returns 可给历史的字节数；固定开销已超上限时为 0。
 */
export function historyBytes(signature: string, contextTokens: number, fixedBytes: number, factor?: number): number {
    const margin = Math.max(contextTokens * CONTEXT_MARGIN_RATIO, MIN_CONTEXT_MARGIN_TOKENS)
    const limit = Math.floor((contextTokens - margin) * (factor || ledgerFor(signature).factor))
    const overhead = Number.isFinite(fixedBytes) && fixedBytes > 0 ? fixedBytes : 0
    return Math.max(0, limit - overhead)
}

/**
 * 记录一次成功请求的观测值，并据此更新因子。
 *
 * `inputTokens` 必须为正的有限数；否则本次观测被丢弃，因子保持不变。
 * @param signature - 决策端点与模型标识的组合。
 * @param bodyBytes - 实际发送的请求体字节数。
 * @param inputTokens - 响应回报的输入 token 数。
 * @returns 更新后的因子；观测被丢弃或账本尚未建立时缺省。
 */
export function observe(signature: string, bodyBytes: number, inputTokens: number): number | undefined {
    if (!Number.isFinite(inputTokens) || inputTokens <= 0) return budgetState()?.factor
    if (!Number.isFinite(bodyBytes) || bodyBytes <= 0) return budgetState()?.factor
    const current = ledgerFor(signature)
    current.totalBytes += bodyBytes
    current.totalTokens += inputTokens
    current.factor = current.totalBytes / current.totalTokens
    return current.factor
}

/**
 * 回退因子：按 {@link FALLBACK_STEP} 递减，不低于 {@link MIN_TOKEN_FACTOR}。
 * 端点可达但拒绝了请求，常见于请求体超出上下文，429 只表示限流，同样不回退。
*
 * @param signature - 决策端点与模型标识的组合。
 * @param status - 收到的 HTTP 状态码。
 * @returns 回退后的因子；回调未生效时缺省。
 */
export function fallbackFactor(signature: string, status: number): number | undefined {
    if (status === 200 || status === 429) return budgetState()?.factor
    const current = ledgerFor(signature)
    current.factor = Math.max(MIN_TOKEN_FACTOR, current.factor - FALLBACK_STEP)
    return current.factor
}

/** 当前账本的只读快照，供诊断与测试使用。 */
export function budgetState(): {
    readonly signature: string
    readonly totalBytes: number
    readonly totalTokens: number
    readonly factor: number
} | undefined {
    if (ledger === undefined) return undefined
    return {
        signature: ledger.signature,
        totalBytes: ledger.totalBytes,
        totalTokens: ledger.totalTokens,
        factor: ledger.factor,
    }
}
