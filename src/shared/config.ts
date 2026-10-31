/**
 * 配置形态的跨半共享定义：字段键、默认值、预设候选与固定常量。
 *
 * 只放纯数据与纯函数，不导入宿主包，故 Node 半与浏览器半共用同一份取值。
 *
 * @module dsh-auto-review-systemOne/shared/config
 */

/** 配置命名空间：等于 patch 条目 id。 */
export const CONFIG_NS = 'auto-review-systemOne'

/** 插件名（npm 包名）。 */
export const PLUGIN_NAME = 'dsh-auto-review-systemOne'

/** 凭据引用名：写死而非配置项，值走宿主凭据管理。 */
export const CREDENTIAL_REF = 'TIKAFLOW_SYSTEMONE_API_KEY'

/** 降级提示的推送路由（落在 `/api` 之下）。 */
export const NOTICE_ROUTE = `/api/${CONFIG_NS}/notice`

/** 同一路由的文档相对形式，供浏览器半直接使用。 */
export const NOTICE_URL = NOTICE_ROUTE.slice(1)

/** 连通性测试的路由（落在 `/api` 之下）。 */
export const TEST_ROUTE = `/api/${CONFIG_NS}/test`

/** 同一路由的文档相对形式，供浏览器半直接使用。 */
export const TEST_URL = TEST_ROUTE.slice(1)

/** 审查请求保留的最近可丢弃历史条目数；权威角色不受此限。 */
export const HISTORY_WINDOW = 128

/** 审查请求中可丢弃历史的字符预算；超出时从最旧一条开始丢，权威角色不计入。 */
export const HISTORY_CHAR_BUDGET = 48 * 1024

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

/** 两个「去向」配置项共用的候选。 */
export const PRESET_OPTIONS = ['read-only', 'workspace-write', 'danger-full-access'] as const

/** 一个权限预设的取值。 */
export type PresetOption = (typeof PRESET_OPTIONS)[number]

/** 解析后的审查配置。 */
export interface ReviewConfig {
    /** 端点基址，不含 `/systemone`。 */
    readonly baseURL: string
    /** 基址是否已含完整路径；为真时不追加 `/systemone`。 */
    readonly fullURL: boolean
    /** 决策模型标识。 */
    readonly model: string
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
    model: '',
    /** 基准阈值：所有问题因子的乘数基准。 */
    confidenceThreshold: 0.8,
    onSessionReset: 'workspace-write',
    onApiUnavailable: 'workspace-write',
    notifyOnFallback: true,
}

/** 字段键的中文名。 */
export const CONFIG_LABELS: Readonly<Record<ConfigKey, string>> = {
    baseURL: 'API 地址',
    fullURL: '地址为完整 URL',
    model: '模型 ID',
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
