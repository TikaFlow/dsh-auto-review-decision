/**
 * 配置形态的跨半共享定义：字段键、默认值、预设候选与固定常量。
 *
 * 只放纯数据与纯函数，不导入宿主包，故 Node 半与浏览器半共用同一份取值。
 *
 * @module dsh-auto-review-decision/shared/config
 */

/** 配置命名空间：等于 patch 条目 id。 */
export const CONFIG_NS = 'auto-review-decision'

/** 插件名（npm 包名）。 */
export const PLUGIN_NAME = 'dsh-auto-review-decision'

/** 凭据引用名：写死而非配置项，值走宿主凭据管理。 */
export const CREDENTIAL_REF = 'TIKAFLOW_DECISION_API_KEY'

/** 降级提示的推送路由（落在 `/api` 之下）。 */
export const NOTICE_ROUTE = `/api/${CONFIG_NS}/notice`

/** 同一路由的文档相对形式，供浏览器半直接使用。 */
export const NOTICE_URL = NOTICE_ROUTE.slice(1)

/** 连通性测试的路由（落在 `/api` 之下）。 */
export const TEST_ROUTE = `/api/${CONFIG_NS}/test`

/** 同一路由的文档相对形式，供浏览器半直接使用。 */
export const TEST_URL = TEST_ROUTE.slice(1)

/** 审查状态统计的只读路由（落在 `/api` 之下）。 */
export const STATS_ROUTE = `/api/${CONFIG_NS}/stats`

/** 同一路由的文档相对形式，供浏览器半直接使用。 */
export const STATS_URL = STATS_ROUTE.slice(1)

/** 连通性测试的插件侧失败码：卡片按码取词典文案。 */
export type ProbeFailureCode =
    | 'baseURLInvalid'
    | 'credentialMissing'
    | 'authHeaderInvalid'
    | 'rateLimited'
    | 'networkFailed'
    | 'unknownFailure'
    | 'invalidResponse'
    | 'probeFailed'

/** 最近保留多少条历史条目（不含待审调用）按权威处理：不论角色，一律不裁剪。 */
export const RECENT_KEEP = 10

/** 最早保留多少条历史条目。 */
export const HEAD_KEEP = 10

/** 上下文窗口下限（token）。 */
export const MIN_CONTEXT_TOKENS = 8192

/** 置信度阈值下限。 */
export const MIN_CONFIDENCE_THRESHOLD = 0.6

/** 置信度阈值上限：再高则判定几乎必然失败。 */
export const MAX_CONFIDENCE_THRESHOLD = 0.99

/** 请求超时（毫秒）。 */
export const REVIEW_TIMEOUT_MS = 30_000

/** 连续失败降级阈值。 */
export const FALLBACK_FAILURE_THRESHOLD = 10

/** 评分题档位数。 */
export const SCORE_LEVELS = 5

/** 安全侧累积概率的起点档位。 */
export const SAFE_LEVEL_START = 2

/** 高安全档位的起点档位。 */
export const HIGH_LEVEL_START = 3

/** 明确安全档在安全侧中的最低占比。 */
export const MIN_HIGH_RATIO = 0.6

/** 「去向」哨兵值，实时读取宿主的默认新会话预设。 */
export const SYSTEM_TARGET = 'system'

/** 两个「去向」配置项共用的候选；`system` 表示沿用宿主默认新会话预设。 */
export const PRESET_OPTIONS = ['read-only', 'workspace-write', 'danger-full-access', 'system'] as const

/** 一个权限预设的取值。 */
export type PresetOption = (typeof PRESET_OPTIONS)[number]

/** 解析后的审查配置。 */
export interface ReviewConfig {
    /** 端点基址，不含 `/systemone`。 */
    readonly baseURL: string
    /** 基址是否已含完整路径；为真时不追加 `/systemone`。 */
    readonly fullURL: boolean
    /** 认证头：空为只发 Bearer；裸头名追加该头；`!` 前缀替换 Bearer。 */
    readonly authHeader: string
    /** 决策模型标识。 */
    readonly model: string
    /** 决策模型上下文窗口（token）。 */
    readonly contextTokens: number
    /** 用户白名单：这些工具免于决策模型审查。 */
    readonly toolWhitelist: readonly string[]
    /** 所有问题的基准阈值。 */
    readonly confidenceThreshold: number
    /** 插件卸载或会话重置时的去向。 */
    readonly onSessionReset: PresetOption
    /** 连续失败降级后的去向。 */
    readonly onApiUnavailable: PresetOption
    /** 降级时是否提示用户。 */
    readonly notifyOnFallback: boolean
}

/** 一个配置字段键。 */
export type ConfigKey = keyof ReviewConfig

/** 缺省配置。 */
export const DEFAULT_CONFIG: ReviewConfig = {
    baseURL: '',
    fullURL: false,
    authHeader: '',
    model: '',
    contextTokens: 24 * 1024,
    toolWhitelist: [],
    /** 基准阈值：所有问题因子的乘数基准。 */
    confidenceThreshold: 0.8,
    onSessionReset: 'system',
    onApiUnavailable: 'system',
    notifyOnFallback: true,
}

/** 字段键的中文名。 */
export const CONFIG_LABELS: Readonly<Record<ConfigKey, string>> = {
    baseURL: 'API 地址',
    fullURL: '地址为完整 URL',
    authHeader: '认证头',
    model: '模型 ID',
    contextTokens: '上下文窗口',
    toolWhitelist: '工具白名单',
    confidenceThreshold: '置信度阈值',
    onSessionReset: '会话重置时的权限模式',
    onApiUnavailable: '接口不可用时的权限模式',
    notifyOnFallback: '降级时提示用户',
}

/**
 * 拼出决策端点。
 * @param baseURL - 已校验的基址。
 * @param fullURL - 基址是否已含完整路径；为真时只去掉末尾斜杠。
 * @returns 决策端点 URL。
 */
export function decisionEndpoint(baseURL: string, fullURL: boolean): string {
    const trimmed = baseURL.replace(/\/+$/u, '')
    return fullURL ? trimmed : `${trimmed}/systemone`
}

/**
 * 校验端点基址。
 * @param value - 配置里的基址。
 * @returns 不合法原因，合法时返回 undefined。
 */
export function baseURLProblem(value: string): string | undefined {
    if (value === '') return undefined
    let url: URL
    try {
        url = new URL(value)
    } catch {
        return '不是合法的 URL'
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '协议必须是 http 或 https'
    if (url.search !== '' || url.hash !== '') return '不应带查询串或片段'
    return undefined
}

/** 单位换算表：后缀到倍数。 */
const TOKEN_UNIT_MULTIPLIER: Readonly<Record<string, number>> = {
    k: 1024,
    m: 1024 * 1024,
}

/** RFC 7230 的 tchar：HTTP 头名只允许这些字符。 */
const TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u

/**
 * 归一并校验「认证头」草稿：整体 trim → 全角 `！` 视同 `!` → 剥前缀 → 再 trim。
 * 若命中已有头，如 authorization，则发送侧静默删除。
*
 * @param text - 原始草稿。
 * @returns 归一后的取值（保留 `!` 前缀）；空串表示未配置；头名非法或只填 `!` 时 undefined。
 */
export function parseAuthHeader(text: string): string | undefined {
    const normalized = text.trim().replaceAll('！', '!')
    const replace = normalized.startsWith('!')
    const name = (replace ? normalized.slice(1) : normalized).trim()
    if (name === '') return replace ? undefined : ''
    if (!TOKEN_PATTERN.test(name)) return undefined
    return replace ? `!${name}` : name
}

/**
 * 解析「上下文窗口」草稿：正整数，或正整数 + K/M 单位（大小写均可，无空格）。
 *
 * @param text - 去除首尾空白后的草稿。
 * @returns 换算后的 token 数；非法时 undefined。
 */
export function parseContextTokens(text: string): number | undefined {
    const match = /^(\d+)([KkMm]?)$/u.exec(text)
    if (match === null) return undefined
    const value = Number(match[1])
    const unit = match[2].toLowerCase()
    const tokens = value * (unit === '' ? 1 : TOKEN_UNIT_MULTIPLIER[unit])
    if (!Number.isSafeInteger(tokens) || tokens < MIN_CONTEXT_TOKENS) return undefined
    return tokens
}

/**
 * 解析「工具白名单」草稿：逗号分隔（仅 `,`），每项去除首尾空白，过滤空项。
 *
 * @param text - 待解析的草稿。
 * @returns 去空白、滤空后的工具名数组。
 */
export function parseToolWhitelist(text: string): string[] {
    const items: string[] = []
    for (const item of text.split(',')) {
        const name = item.trim()
        if (name !== '') items.push(name)
    }
    return items
}
