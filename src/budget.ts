/**
 * 审查预算的自校准：由历史请求的字节数与返回 token 数推算 token 因子，据此给出本次可用的字节上限。
 *
 * 状态跨请求累计；决策端点或模型标识变化即整体重置，使因子始终对应当前端点。
 *
 * @module dsh-auto-review-systemOne/budget
 */

/** 决策模型 `state` 加最长问题的硬上限（token）；取 31K 留出压线余量。 */
const HARD_STATE_TOKENS = 31 * 1024

/** token 因子的初始值：每个 token 平均对应的字节数。 */
const INITIAL_TOKEN_FACTOR = 3

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
 * 本次剪裁允许的最大字节数。
 * @param signature - 决策端点与模型标识的组合，变化即重置。
 * @returns `HARD_STATE_TOKENS * factor`。
 */
export function maxBytes(signature: string): number {
    return HARD_STATE_TOKENS * ledgerFor(signature).factor
}

/**
 * 记录一次成功请求的观测值，并据此更新因子。
 *
 * `inputTokens` 必须为正的有限数；否则本次观测被丢弃，因子保持不变。
 * @param signature - 决策端点与模型标识的组合。
 * @param bodyBytes - 实际发送的请求体字节数。
 * @param inputTokens - 响应回报的输入 token 数。
 */
export function observe(signature: string, bodyBytes: number, inputTokens: number): void {
    if (!Number.isFinite(inputTokens) || inputTokens <= 0) return
    if (!Number.isFinite(bodyBytes) || bodyBytes <= 0) return
    const current = ledgerFor(signature)
    current.totalBytes += bodyBytes
    current.totalTokens += inputTokens
    current.factor = current.totalBytes / current.totalTokens
}

/** 清空账本，下一次调用重新从初始因子开始。 */
export function resetBudget(): void {
    ledger = undefined
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
