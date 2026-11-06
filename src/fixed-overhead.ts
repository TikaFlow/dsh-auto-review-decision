/**
 * 固定开销的计量：与 history 并列计入 `state` 且无法裁剪的部分。
 *
 * @module dsh-auto-review-decision/fixed-overhead
 */

import { byteLength } from './shared/bytes.ts'

/** state 外壳与 history 数组括号的固定字节数。 */
const FIXED_STATE_OVERHEAD_BYTES = 50

/** 与 history 并列计入 state、且无法裁剪的固定部分。 */
export interface FixedStateParts {
    /** 环境，通常只有 cwd。 */
    readonly environment: unknown
    /** 固定策略文本。 */
    readonly policy: string
    /** 待审调用。 */
    readonly pending: unknown
    /** 全部问题；按整份表计入。 */
    readonly questions: Readonly<Record<string, unknown>>
}

/** 固定部分的一次序列化结果：字节数与请求体文本同源。 */
export interface SerializedFixedState {
    /** environment、policy、pending、全部 questions 与固定外壳的字节数合计。 */
    readonly bytes: number
    /** `state.environment` 的 JSON 文本。 */
    readonly environment: string
    /** `state.policy` 的 JSON 文本。 */
    readonly policy: string
    /** `state.pending` 的 JSON 文本。 */
    readonly pending: string
    /** `questions` 的 JSON 文本。 */
    readonly questions: string
}

/**
 * 序列化固定部分：每部分只序列化一次，字节数与请求体文本共用同一结果。
 *
 * @param parts - 与 history 并列的固定部分。
 * @returns 各部分的 JSON 文本，以及含外壳的固定开销字节数。
 */
export function serializeFixedState(parts: FixedStateParts): SerializedFixedState {
    const environment = JSON.stringify(parts.environment)
    const policy = JSON.stringify(parts.policy)
    const pending = JSON.stringify(parts.pending)
    const questions = JSON.stringify(parts.questions)
    return {
        bytes: FIXED_STATE_OVERHEAD_BYTES
            + byteLength(environment)
            + byteLength(policy)
            + byteLength(pending)
            + byteLength(questions),
        environment,
        policy,
        pending,
        questions,
    }
}
