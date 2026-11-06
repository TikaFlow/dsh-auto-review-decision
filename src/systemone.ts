/**
 * SystemOne 决策接口的线协议类型。
 *
 * 本文件只声明外部 HTTP 契约，不含任何调用逻辑。
 * 协议细节见 docs/systemone-protocol.md。
 *
 * @module dsh-auto-review-decision/systemone
 */

/** 问题类型：是/否概率、封闭选项选择、有序档位评分。 */
export type SystemOneQuestionType = 'noul' | 'choice' | 'score'

/**
 * 是/否问题的判定标准。
 * 两端均可省略；省略时由 instructions 独立表达命题。
 */
export interface SystemOneNoulCriteria {
    /** 命题为真时的判定说明。 */
    readonly true?: string
    /** 命题为假时的判定说明。 */
    readonly false?: string
}

/**
 * 选择题的选项表：选项名 → 选项说明。
 * 说明可为 null，表示选项名本身已足够自明。选项数量上限 255。
 */
export type SystemOneChoiceCriteria = Readonly<Record<string, string | null>>

/**
 * 评分题的档位说明，按从低到高排列。
 * 档位数量 2–10（部分实现接受 1–10）。
 */
export type SystemOneScoreCriteria = readonly string[]

/** 一条问题定义。 */
export interface SystemOneQuestion {
    /** 问题类型，决定 criteria 与对应答案字段的形状。 */
    readonly type: SystemOneQuestionType
    /**
     * 问题的自然语言表述。
     * 多数实现要求必填；部分实现省略时以问题 id 作为问题本身。
     */
    readonly instructions?: string
    /** 判定标准，形状由 type 决定。 */
    readonly criteria?: SystemOneNoulCriteria | SystemOneChoiceCriteria | SystemOneScoreCriteria
}

/** 问题表：调用方自选的 id → 问题定义。响应以同样的 id 回填答案。 */
export type SystemOneQuestions = Readonly<Record<string, SystemOneQuestion>>

/** 决策所针对的业务状态：文本、结构化对象或数组，对象与数组在发送前序列化。 */
export type SystemOneState = string | Readonly<Record<string, unknown>> | readonly unknown[]

/** 一次决策请求的请求体。 */
export interface SystemOneRequest {
    /**
     * 决策模型标识。
     * 托管服务必填；引擎固定为单模型的自建实现会忽略或省略该字段。
     */
    readonly model?: string
    /** 待判定的业务状态。 */
    readonly state: SystemOneState
    /** 至少包含一条问题。 */
    readonly questions: SystemOneQuestions
    /** 与状态关联的图片，base64 data URI；仅接受图片的模型支持。 */
    readonly images?: readonly string[]
    /** 与状态关联的视频，base64 data URI；仅接受视频的模型支持。 */
    readonly videos?: readonly string[]
}

/**
 * 是/否答案。
 * `noul` 即 P(真)，取值 0–1，0.5 表示无法判定。
 */
export interface SystemOneNoulAnswer {
    readonly type: 'noul'
    /** 命题为真的概率。 */
    readonly noul: number
    /** 是/否两端的概率分布，部分实现返回。 */
    readonly probabilities?: Readonly<Record<'yes' | 'no', number>>
    /** 部分实现（如 vLLM）额外返回的置信度。 */
    readonly confidence?: number
}

/** 选择题答案。 */
export interface SystemOneChoiceAnswer {
    readonly type: 'choice'
    /** 被选中的选项名。 */
    readonly choice: string
    /**
     * 答案置信度，0–1。
     * 它是概率分布的集中程度，不等于 probabilities 的最大值，也可能缺失。
     */
    readonly confidence?: number
    /** 每个选项的概率，总和为 1，通常保留两位小数。 */
    readonly probabilities?: Readonly<Record<string, number>>
}

/**
 * 评分题答案。
 * `score` 是档位序号的概率加权期望（从 0 起算），可为小数，因此可落在两档之间。
 */
export interface SystemOneScoreAnswer {
    readonly type: 'score'
    /** 档位序号的期望值。 */
    readonly score: number
    /** 档位序号 → 档位说明，便于无需持有原请求即可渲染结果。 */
    readonly legend?: Readonly<Record<string, string>>
    /** 每个档位的概率，键为档位序号的字符串形式。 */
    readonly probabilities?: Readonly<Record<string, number>>
    /**
     * 答案置信度，0–1。
     * 与选择题相同，不等于最大档位概率，也可能缺失。
     */
    readonly confidence?: number
}

/** 一条问题对应的答案，按问题类型区分。 */
export type SystemOneAnswer = SystemOneNoulAnswer | SystemOneChoiceAnswer | SystemOneScoreAnswer

/** 答案表：与请求 questions 的 id 一一对应。 */
export type SystemOneAnswers = Readonly<Record<string, SystemOneAnswer>>

/** 计量信息。 */
export interface SystemOneUsage {
    /** 输入 token 数。 */
    readonly input_tokens: number
    /** 输出 token 数；决策模型不生成文本，多数实现不返回。 */
    readonly output_tokens?: number
    /** 总 token 数，部分实现返回。 */
    readonly total_tokens?: number
}

/** 一次决策请求的响应体。 */
export interface SystemOneResponse {
    /** 实际作答的模型标识。 */
    readonly model: string
    /** 每个问题 id 对应的答案。 */
    readonly answers: SystemOneAnswers
    /** 计量信息。 */
    readonly usage?: SystemOneUsage
    /** 决策记录 id，部分实现返回。 */
    readonly id?: string
    /** 对象类型标记，部分实现返回。 */
    readonly object?: string
    /** 创建时间戳（秒），部分实现返回。 */
    readonly created?: number
    /** 请求追踪 id，部分实现返回。 */
    readonly request_id?: string
    /** 服务端耗时（毫秒），部分实现返回。 */
    readonly latency_ms?: number
    /** 服务端评估耗时（毫秒），部分实现返回。 */
    readonly evaluation_time_ms?: number
}

/** 调用失败时的错误响应体；字段随实现而异，故整体宽松。 */
export interface SystemOneErrorResponse {
    /** 错误类型或分类。 */
    readonly error?: string | { readonly type?: string; readonly message?: string; readonly code?: string }
    /** 面向调用方的错误说明。 */
    readonly message?: string
    /** 实现自定义的错误码。 */
    readonly code?: string | number
}
