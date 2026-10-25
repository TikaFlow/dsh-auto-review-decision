/**
 * 审查问题表的 id 与顺序：纯数据，不含问法、档位与判定规则。
 *
 * @module dsh-auto-review-systemOne/shared/questions
 */

/** 总判定问题的 id：P(这次调用允许以完整主机权限执行)。 */
export const DECISION_QUESTION_ID = 'allow'

/** 9 个辅助判定问题的 id，按判定顺序排列（越靠前越先决定结果）。 */
export const SCORE_QUESTION_IDS = [
    'malice',
    'data_sensitivity',
    'description_match',
    'safety',
    'authorization',
    'scope',
    'external_effect',
    'task_fit',
    'necessity',
] as const

/** 一个辅助判定问题的 id。 */
export type ScoreQuestionId = (typeof SCORE_QUESTION_IDS)[number]

/** 不可商量的问题：未达标即拒绝，不询问用户。 */
export const NON_NEGOTIABLE_QUESTION_IDS: readonly ScoreQuestionId[] = [
    'malice',
    'data_sensitivity',
    'description_match',
]

/**
 * 判断某问题是否不可商量。
 * @param id - 辅助判定问题的 id。
 * @returns 是否不可商量。
 */
export function isNonNegotiable(id: ScoreQuestionId): boolean {
    return NON_NEGOTIABLE_QUESTION_IDS.includes(id)
}
