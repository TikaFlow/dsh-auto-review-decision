/**
 * 审查状态统计的线形态、载荷读取与时间格式：两半共用，零宿主依赖。
 *
 * @module dsh-auto-review-decision/shared/stats
 */

import { isRecord } from './tools.ts'

/** 审查运行的全部统计字段：计数与派生量都在记账时落成普通字段。 */
export interface ReviewStats {
    /** 审查次数：每次进入 decide 计一次。 */
    reviewCount: number
    /** 未发出请求就落地的本地审查次数。 */
    localReviews: number
    /** 模型审查次数：含配置错误。 */
    modelReviews: number
    /** 配置或凭据错误导致零请求的次数。 */
    configErrors: number
    /** HTTP 尝试次数。 */
    requests: number
    /** 429 重试尝试次数。 */
    retries: number
    /** 尝试以有效响应结束的次数。 */
    succeeded: number
    /** 尝试以非 429 失败结束的次数。 */
    failed: number
    /** 尝试以 429 结束的次数。 */
    rateLimited: number
    /** 结论为直接拒绝的次数。 */
    denied: number
    /** 结论为询问用户的次数。 */
    asked: number
    /** 成功响应触发因子校准的次数。 */
    calibrations: number
    /** 实际降级次数。 */
    fallbacks: number
    /** 因子回退的次数。 */
    factorFallbacks: number
    /** 当前连续失败次数；成功、429、重选 Auto、配置更新或插件装载时清零。 */
    consecutiveFailures: number
    /** 本次装载是否已触发降级；重选 Auto 或插件装载时清零。 */
    degraded: boolean
    /** 累计发送字节数，含 429 重试重发的请求体。 */
    sentBytes: number
    /** 累计输入 token 数；只计成功响应回报的 usage。 */
    inputTokens: number
    /** 累计耗时（毫秒），按每次尝试的结局累加。 */
    totalMs: number
    /** 平均每次尝试耗时：`totalMs / requests`。 */
    averageMs: number
    /** 当前 token 因子；尚未上报时缺省。 */
    factor?: number
    /** 最近一次尝试的请求体字节数。 */
    lastBytes?: number
    /** 最近一次成功响应回报的输入 token 数；最近一次非成功时缺省。 */
    lastTokens?: number
    /** 最近一次单次因子：字节数除以 token 数；无 token 时缺省。 */
    lastFactor?: number
    /** 上次降级的本地时间戳（毫秒）。 */
    lastFallbackAt?: number
    /** 上次成功的本地时间戳（毫秒）。 */
    lastSuccessAt?: number
    /** 上次失败或 429 的本地时间戳（毫秒）。 */
    lastFailureAt?: number
}

/**
 * 把统计数值格式化为面板文本。
 * @param value - 待格式化的数值；非有限值走占位符或按 `0` 输出。
 * @param option - 占位符、单位、固定小数位与当前时间。
 * @returns 面板文本；占位符不拼单位。
 */
export function formatStatValue(value: number | undefined,
    option?: {
        placeholder?: string,
        unit?: string,
        fixed?: number,
        now?: number
    }): string {
    if (!Number.isFinite(value)) {
        if (option?.placeholder !== undefined) return option.placeholder
        return option?.unit === undefined ? '0' : `0 ${option.unit}`
    }
    const num = value as number
    const suffix = option?.unit === undefined ? '' : ` ${option.unit}`
    if (option?.now !== undefined) return `${formatStatTime(num, option.now)}${suffix}`

    // 固定小数位后去掉末尾 0（`2.00` → `2`）是面板既有口径。
    const text = option?.fixed !== undefined
        ? String(Number(num.toFixed(option.fixed)))
        : num.toLocaleString()
    return `${text}${suffix}`
}

/**
 * 把时间戳读成本地可读格式：当天只给 `HH:mm:ss`，跨天补 `YYYY-MM-DD`。
 * @param at - 时间戳（毫秒）。
 * @param now - 当前时间戳（毫秒），用于判断是否跨天。
 * @returns 本地时区可读时间。
 */
export function formatStatTime(at: number, now: number): string {
    const pad = (value: number): string => String(value).padStart(2, '0')

    const value = new Date(at)
    const current = new Date(now)
    const clock = `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
    const sameDay = value.getFullYear() === current.getFullYear()
        && value.getMonth() === current.getMonth()
        && value.getDate() === current.getDate()
    return sameDay
        ? clock
        : `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${clock}`
}

/** 读一个数字字段；缺失或非有限数时返回 undefined。 */
function statNumber(record: Record<string, unknown>, key: string): number | undefined {
    const value = record[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 把统计路由的载荷读成统计字段：只有整体不是对象才算不可用，缺字段交给各 Pill 的默认值。
 * @param payload - 统计路由返回的 JSON 载荷。
 * @returns 统计字段；载荷不可用时缺省。
 */
export function parseStats(payload: unknown): ReviewStats | undefined {
    if (!isRecord(payload)) return undefined
    return {
        reviewCount: statNumber(payload, 'reviewCount') ?? 0,
        modelReviews: statNumber(payload, 'modelReviews') ?? 0,
        retries: statNumber(payload, 'retries') ?? 0,
        localReviews: statNumber(payload, 'localReviews') ?? 0,
        configErrors: statNumber(payload, 'configErrors') ?? 0,
        requests: statNumber(payload, 'requests') ?? 0,
        succeeded: statNumber(payload, 'succeeded') ?? 0,
        failed: statNumber(payload, 'failed') ?? 0,
        rateLimited: statNumber(payload, 'rateLimited') ?? 0,
        consecutiveFailures: statNumber(payload, 'consecutiveFailures') ?? 0,
        degraded: payload.degraded === true,
        calibrations: statNumber(payload, 'calibrations') ?? 0,
        fallbacks: statNumber(payload, 'fallbacks') ?? 0,
        factorFallbacks: statNumber(payload, 'factorFallbacks') ?? 0,
        sentBytes: statNumber(payload, 'sentBytes') ?? 0,
        inputTokens: statNumber(payload, 'inputTokens') ?? 0,
        totalMs: statNumber(payload, 'totalMs') ?? 0,
        averageMs: statNumber(payload, 'averageMs') ?? 0,
        denied: statNumber(payload, 'denied') ?? 0,
        asked: statNumber(payload, 'asked') ?? 0,
        factor: statNumber(payload, 'factor'),
        lastBytes: statNumber(payload, 'lastBytes'),
        lastTokens: statNumber(payload, 'lastTokens'),
        lastFactor: statNumber(payload, 'lastFactor'),
        lastFallbackAt: statNumber(payload, 'lastFallbackAt'),
        lastSuccessAt: statNumber(payload, 'lastSuccessAt'),
        lastFailureAt: statNumber(payload, 'lastFailureAt'),
    }
}
