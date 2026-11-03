/**
 * 决策落地：把审查结论物化为工具流水线可消费的决定。
 *
 * @module dsh-auto-review-decision/verdict
 */

import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { deniedDisplayReason, type LocalizedText } from './locales.ts'

/** 审查者最终拒绝时持久化的结构化错误名。 */
const AUTO_REVIEW_DENIED_ERROR_NAME = 'AutoReviewDeniedError'
/** 审查者最终拒绝时持久化的结构化错误码。 */
const AUTO_REVIEW_DENIED_CODE = 'AUTO_REVIEW_DENIED'
/** 审查无法产出结论时持久化的结构化错误名。 */
const AUTO_REVIEW_FAILED_ERROR_NAME = 'AutoReviewFailedError'
/** 审查无法产出结论时持久化的结构化错误码。 */
const AUTO_REVIEW_FAILED_CODE = 'AUTO_REVIEW_FAILED'

/** 把一次最终拒绝物化；理由供 AI 读取后修正调用。 */
export function denied(exec: ToolExecution, reason: LocalizedText): PreToolDecision {
    return {
        kind: 'deny',
        reason: `Auto review rejected tool "${exec.name}"; its body was not executed`,
        info: {
            name: AUTO_REVIEW_DENIED_ERROR_NAME,
            code: AUTO_REVIEW_DENIED_CODE,
            reason: reason.en,
        },
    }
}

/**
 * 请求用户裁决一次审查者已拒绝的调用。审计理由为英文，
 * 提示文案本地化，并保留审查者的原始理由。
 */
export function askUser(exec: ToolExecution, reason?: LocalizedText): PreToolDecision {
    const denial = `Auto review denied tool "${exec.name}"`
    return {
        kind: 'ask',
        reason: reason === undefined ? denial : `${denial}: ${reason.en}`,
        displayReason: deniedDisplayReason(reason),
    }
}

/** 把审查失败物化为独立错误，而非拒绝。 */
export function failed(exec: ToolExecution, error: unknown): PreToolDecision {
    const message = error instanceof Error ? error.message : String(error)
    return {
        kind: 'deny',
        reason: `Auto review of tool "${exec.name}" failed; its body was not executed: ${message}`,
        info: { name: AUTO_REVIEW_FAILED_ERROR_NAME, code: AUTO_REVIEW_FAILED_CODE },
    }
}
