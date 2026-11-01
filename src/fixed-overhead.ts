/**
 * 固定开销的计量：与 history 并列计入 `state` 且无法裁剪的部分。
 *
 * @module dsh-auto-review-decision/fixed-overhead
 */

import { byteLength } from './shared/bytes.ts'

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

/**
 * 固定开销的字节数：environment、policy、pending 与全部 questions。
 *
 * @param parts - 与 history 并列的固定部分。
 * @returns 固定开销的字节数。
 */
export function fixedStateBytes(parts: FixedStateParts): number {
    return byteLength(JSON.stringify(parts.environment))
        + byteLength(parts.policy)
        + byteLength(JSON.stringify(parts.pending))
        + byteLength(JSON.stringify(parts.questions))
}
