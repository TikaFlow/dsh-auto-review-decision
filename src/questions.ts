/**
 * 审查问题表与判定规则：由 SystemOne 的答案得出放行、拒绝或询问。
 *
 * @module dsh-auto-review-systemOne/questions
 */

import { HIGH_LEVEL_START, MIN_HIGH_RATIO, SAFE_LEVEL_START, SCORE_LEVELS } from './shared/config.ts'
import {
    DECISION_INSTRUCTIONS,
    DECISION_QUESTION_ID,
    SCORE_QUESTION_IDS,
    SCORE_QUESTION_SPECS,
    QUESTION_LABELS,
    isNonNegotiable,
} from './shared/questions.ts'
import type { SystemOneQuestions, SystemOneResponse } from './systemone.ts'

/** 一次审查的结论。 */
export type ReviewVerdict =
    | { readonly kind: 'allow' }
    | { readonly kind: 'deny'; readonly reason: string }
    | { readonly kind: 'ask'; readonly reason: string }

/** 构造本插件的问题表 */
export function decisionQuestions(): SystemOneQuestions {
    return {
        [DECISION_QUESTION_ID]: { type: 'noul', instructions: DECISION_INSTRUCTIONS },
        ...Object.fromEntries(SCORE_QUESTION_IDS.map(id => [
            id,
            {
                type: 'score',
                instructions: SCORE_QUESTION_SPECS[id].instructions,
                criteria: SCORE_QUESTION_SPECS[id].criteria,
            },
        ])),
    } as SystemOneQuestions
}

/** 从响应里取出一条答案。 */
function readAnswer(response: SystemOneResponse, id: string): Record<string, unknown> | undefined {
    const answer = response.answers?.[id]
    return typeof answer === 'object' && answer !== null ? answer as unknown as Record<string, unknown> : undefined
}

/** 一条 score 答案的安全度指标。 */
export interface SafetyMetrics {
    /** 安全侧累积概率：P(2)+P(3)+P(4)。 */
    readonly safety: number
    /** 明确安全档（P(3)+P(4)）。 */
    readonly high: number
    /** 明确安全档在安全侧中的占比。 */
    readonly highRatio: number
    /** 是否为按期望档位估算的路径。 */
    readonly estimated: boolean
}

/** 计算一条 score 答案的安全度指标：优先取 probabilities，缺失时用期望档位换算。 */
export function safetyOf(answer: Record<string, unknown>): SafetyMetrics {
    const probabilities = answer.probabilities
    if (typeof probabilities === 'object' && probabilities !== null) {
        const values = probabilities as Record<string, unknown>
        let safe = 0
        let high = 0
        let counted = false
        for (let level = SAFE_LEVEL_START; level < SCORE_LEVELS; level += 1) {
            const value = values[String(level)]
            if (typeof value !== 'number' || !Number.isFinite(value)) continue
            counted = true
            safe += value
            if (level >= HIGH_LEVEL_START) high += value
        }
        if (counted) {
            return { safety: safe, high, highRatio: safe > 0 ? high / safe : 0, estimated: false }
        }
    }
    const score = answer.score
    const numeric = typeof score === 'number' && Number.isFinite(score) ? score : 0
    const ratio = numeric / (SCORE_LEVELS - 1)
    return { safety: ratio, high: ratio, highRatio: 1, estimated: true }
}

/**
 * 按判定规则得出结论：noul 未达阈值 → 拒绝；问题表首个未达标者决定结果
 * （不可商量→拒绝，可商量→询问）；全部通过 → 放行。
 * @param response - 已通过响应校验的结果。
 * @param threshold - 基准置信度阈值。
 */
export function judge(response: SystemOneResponse, threshold: number): ReviewVerdict {
    const decision = readAnswer(response, DECISION_QUESTION_ID)
    const noul = decision?.noul
    const probability = typeof noul === 'number' && Number.isFinite(noul) ? noul : 0
    if (probability < threshold) {
        return { kind: 'deny', reason: '该调用未通过安全审查' }
    }

    for (const id of SCORE_QUESTION_IDS) {
        const answer = readAnswer(response, id)
        if (answer === undefined) continue
        const { safety, high, highRatio, estimated } = safetyOf(answer)
        const spec = SCORE_QUESTION_SPECS[id]
        const effective = threshold * spec.factor
        const safeEnough = safety >= effective
        // 安全度达标还不够：明确安全档占比过低说明判定多半压在「不确定」档上。
        const confident = highRatio > MIN_HIGH_RATIO
        if (safeEnough && confident) continue

        const label = QUESTION_LABELS[id]
        const detail = safeEnough
            ? `${label}的明确安全档占比不足`
            : `${label}未达标`
        const estimate = estimated ? '，安全度按期望档位估算' : ''
        if (isNonNegotiable(id)) {
            return { kind: 'deny', reason: `${detail}${estimate}` }
        }
        return { kind: 'ask', reason: `${detail}${estimate}，需要你决定` }
    }

    return { kind: 'allow' }
}
