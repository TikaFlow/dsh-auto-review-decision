import assert from 'node:assert/strict'
import { test } from 'node:test'
import { judge, decisionQuestions, safetyOf, type ReviewVerdict } from '../src/questions.ts'
import {
    ALLOW_COMPENSATION,
    CHECK_COMPENSATION,
    DECISION_QUESTION_ID,
    DECISION_QUESTION_SPEC,
    SCORE_QUESTION_IDS,
} from '../src/shared/questions.ts'
import { DEFAULT_CONFIG, SCORE_LEVELS, SAFE_LEVEL_START } from '../src/shared/config.ts'
import type { SystemOneResponse } from '../src/systemone.ts'

/** 基准阈值。 */
const THRESHOLD = DEFAULT_CONFIG.confidenceThreshold

/** 拒绝线。 */
const DENY_LINE = THRESHOLD * DECISION_QUESTION_SPEC.denyFactor

/** 放行线。 */
const ALLOW_LINE = THRESHOLD * DECISION_QUESTION_SPEC.allowFactor

function score(value: number, probabilities?: Record<string, number>) {
    return { type: 'score', score: value, ...(probabilities === undefined ? {} : { probabilities }) }
}

/** 构造响应：总判定 + 各 score 答案。 */
function response(noul: number, scores: Record<string, unknown>): SystemOneResponse {
    const answers: Record<string, unknown> = {
        [DECISION_QUESTION_ID]: { type: 'noul', noul },
    }
    for (const id of SCORE_QUESTION_IDS) {
        answers[id] = scores[id] ?? score(SCORE_LEVELS - 1, { '4': 1 })
    }
    return { model: 'm', answers } as unknown as SystemOneResponse
}

/** 全达标。 */
const ALL_PASS = Object.fromEntries(SCORE_QUESTION_IDS.map(id => [id, score(4, { '4': 1 })]))

test('问题表为 1 个 noul + 9 个 score，顺序与定义一致', () => {
    const questions = decisionQuestions()
    assert.equal(questions[DECISION_QUESTION_ID].type, 'noul')
    const ids = Object.keys(questions).filter(id => id !== DECISION_QUESTION_ID)
    assert.deepEqual(ids, [...SCORE_QUESTION_IDS])
    for (const id of SCORE_QUESTION_IDS) {
        const question = questions[id]
        assert.equal(question.type, 'score')
        assert.equal(typeof question.instructions, 'string')
        const criteria = question.criteria
        assert.ok(Array.isArray(criteria), `${id} 缺少 criteria`)
        assert.equal(criteria.length, SCORE_LEVELS, `${id} 档位数应为 ${SCORE_LEVELS}`)
        for (const text of criteria) assert.equal(typeof text, 'string')
    }
})

test('总判定问题带两端判定说明', () => {
    const criteria = decisionQuestions()[DECISION_QUESTION_ID].criteria
    assert.ok(criteria !== undefined && typeof criteria === 'object' && !Array.isArray(criteria))
    assert.equal(typeof (criteria as { true: string }).true, 'string')
    assert.equal(typeof (criteria as { false: string }).false, 'string')
})

test('全部通过则放行', () => {
    const verdict = judge(response(0.95, ALL_PASS), THRESHOLD)
    assert.deepEqual(verdict as unknown, { kind: 'allow' })
})

test('基准阈值为 0.8', () => {
    assert.equal(DEFAULT_CONFIG.confidenceThreshold, 0.8)
})

test('noul 低于拒绝线则直接拒绝', () => {
    const verdict = judge(response(DENY_LINE - 0.01, ALL_PASS), THRESHOLD)
    assert.equal(verdict.kind, 'deny')
    assert.ok((verdict as { reason: string }).reason.includes('未通过安全审查'))
})

test('noul 落在拒绝线与放行线之间时仍检查辅助问题', () => {
    const mid = (DENY_LINE + ALLOW_LINE) / 2
    assert.deepEqual(judge(response(mid, ALL_PASS), THRESHOLD) as unknown, { kind: 'allow' })
    const blocked = judge(response(mid, { ...ALL_PASS, malice: score(0, { '0': 1 }) }), THRESHOLD)
    assert.equal(blocked.kind, 'deny')
})

test('noul 达到放行线也不短路辅助问题', () => {
    const verdict = judge(response(ALLOW_LINE + 0.01, { ...ALL_PASS, malice: score(0, { '0': 1 }) }), THRESHOLD)
    assert.equal(verdict.kind, 'deny')
    assert.ok((verdict as { reason: string }).reason.includes('存在恶意意图'))
})

test('放行段的辅助阈值放宽：中间段不达标而放行段达标', () => {
    // necessity 因子 0.88：中间段阈值 0.732，放行段 0.676，安全度 0.72 被补偿翻转。
    const answer = score(4, { '0': 0.13, '1': 0.15, '2': 0.27, '3': 0.3, '4': 0.15 })
    const pass = judge(response(ALLOW_LINE, { ...ALL_PASS, necessity: answer }), THRESHOLD)
    assert.equal((pass as { kind: string }).kind, 'allow')
    const check = judge(response((DENY_LINE + ALLOW_LINE) / 2, { ...ALL_PASS, necessity: answer }), THRESHOLD)
    assert.equal((check as { kind: string }).kind, 'ask')
})

test('放行线与拒绝线分别取 0.90 与 0.75', () => {
    assert.equal(DECISION_QUESTION_SPEC.allowFactor, 0.9)
    assert.equal(DECISION_QUESTION_SPEC.denyFactor, 0.75)
    assert.equal(ALLOW_COMPENSATION, 0.96)
    assert.equal(CHECK_COMPENSATION, 1.04)
})

test('不可商量未达标则拒绝', () => {
    const verdict = judge(response(0.95, { ...ALL_PASS, malice: score(0, { '0': 1 }) }), THRESHOLD)
    assert.equal(verdict.kind, 'deny')
    assert.ok((verdict as { reason: string }).reason.includes('存在恶意意图'))
})

test('可商量未达标则询问用户', () => {
    const verdict = judge(response(0.95, { ...ALL_PASS, safety: score(0, { '0': 1 }) }), THRESHOLD)
    assert.equal(verdict.kind, 'ask')
    const reason = (verdict as { reason: string }).reason
    assert.ok(reason.includes('操作不安全'))
    assert.ok(reason.includes('是否执行？'))
})

test('首个未达标者决定结果，不检查后续', () => {
    // malice 与 safety 都不达标，但 malice 在前：拒绝优先
    const first = judge(response(0.95, { ...ALL_PASS, malice: score(0, { '0': 1 }), safety: score(0, { '0': 1 }) }), THRESHOLD)
    assert.equal((first as { reason: string }).reason.includes('存在恶意意图'), true, 'malice 决定结果')
    const second = judge(response(0.95, { ...ALL_PASS, safety: score(0, { '0': 1 }) }), THRESHOLD)
    assert.equal((second as { reason: string }).reason.includes('操作不安全'), true)
})

test('有效阈值按因子下调：0.88 因子的问题阈值更松', () => {
    const pass = judge(response(0.95, { ...ALL_PASS, necessity: score(3, { '2': 0.2, '3': 0.5, '4': 0.12 }) }), THRESHOLD)
    assert.equal((pass as { kind: string }).kind, 'allow')
})

test('安全度取 probabilities 中安全档位之和', () => {
    const { safety, estimated } = safetyOf(score(4, { '0': 0.1, '1': 0.2, '2': 0.3, '3': 0.35, '4': 0.05 }))
    assert.equal(estimated, false)
    assert.ok(Math.abs(safety - 0.7) < 1e-9)
    assert.ok(safety >= SAFE_LEVEL_START / SCORE_LEVELS)
})

test('缺失 probabilities 时用期望档位估算，且理由可识别', () => {
    const { safety, estimated } = safetyOf(score(3))
    assert.equal(estimated, true)
    assert.ok(Math.abs(safety - 3 / (SCORE_LEVELS - 1)) < 1e-9)

    const verdict = judge(response(0.95, { ...ALL_PASS, safety: score(1) }), THRESHOLD)
    assert.equal(verdict.kind, 'ask')
    assert.ok((verdict as { reason: string }).reason.includes('（估算）'))
})

test('概率总和非空但安全档位缺失时按 0 处理', () => {
    const { safety } = safetyOf(score(0, { '0': 0.5, '1': 0.5 }))
    assert.equal(safety, 0)
})

test('安全度达标但明确安全档在安全侧中的占比不足时不放行', () => {
    const verdict = judge(response(0.95, {
        ...ALL_PASS,
        safety: score(4, { '0': 0, '1': 0, '2': 0.9, '3': 0.08, '4': 0.02 }),
    }), THRESHOLD)
    assert.equal(verdict.kind, 'ask')
    const reason = (verdict as { reason: string }).reason
    assert.ok(reason.includes('操作不安全'))
})

test('不可商量问题的明确安全档占比不足直接拒绝', () => {
    const verdict = judge(response(0.95, {
        ...ALL_PASS,
        malice: score(4, { '2': 0.9, '3': 0.08, '4': 0.02 }),
    }), THRESHOLD)
    assert.equal(verdict.kind, 'deny')
    assert.ok((verdict as { reason: string }).reason.includes('存在恶意意图'))
})

test('明确安全档占比恰为 60% 时不放行（需高于）', () => {
    const verdict = judge(response(0.95, {
        ...ALL_PASS,
        safety: score(4, { '2': 0.4, '3': 0.3, '4': 0.3 }),
    }), THRESHOLD)
    assert.equal(verdict.kind, 'ask')
})

test('安全侧之外的低档概率不进入占比分母', () => {
    const { safety, high, highRatio } = safetyOf(score(4, { '0': 0.9, '1': 0, '2': 0.4, '3': 0.3, '4': 0.3 }))
    assert.ok(Math.abs(safety - 1) < 1e-9)
    assert.ok(Math.abs(high - 0.6) < 1e-9)
    assert.ok(Math.abs(highRatio - 0.6) < 1e-9)
})

test('安全度指标同时给出安全侧累积、明确安全概率与其占比', () => {
    const { safety, high, highRatio, estimated } = safetyOf(score(4, { '0': 0.1, '1': 0.1, '2': 0.2, '3': 0.3, '4': 0.3 }))
    assert.equal(estimated, false)
    assert.ok(Math.abs(safety - 0.8) < 1e-9)
    assert.ok(Math.abs(high - 0.6) < 1e-9)
    assert.ok(Math.abs(highRatio - 0.75) < 1e-9)
})

test('估算路径无概率分布，不适用占比条件', () => {
    const { highRatio, estimated } = safetyOf(score(4))
    assert.equal(estimated, true)
    assert.equal(highRatio, 1)
})

test('三条路径的结论类型互斥', () => {
    const kinds = new Set<string>()
    for (const verdict of [
        judge(response(0.95, ALL_PASS), THRESHOLD),
        judge(response(0.1, ALL_PASS), THRESHOLD),
        judge(response(0.95, { ...ALL_PASS, safety: score(0, { '0': 1 }) }), THRESHOLD),
    ] as ReviewVerdict[]) kinds.add(verdict.kind)
    assert.deepEqual([...kinds].sort(), ['allow', 'ask', 'deny'])
})
