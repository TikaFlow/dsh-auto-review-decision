import assert from 'node:assert/strict'
import { test } from 'node:test'
import { judge, decisionQuestions, safetyOf, type ReviewVerdict } from '../src/questions.ts'
import { DECISION_QUESTION_ID, SCORE_QUESTION_IDS } from '../src/shared/questions.ts'
import { SCORE_LEVELS, SAFE_LEVEL_START } from '../src/shared/config.ts'
import type { SystemOneResponse } from '../src/systemone.ts'

/** 基准阈值。 */
const THRESHOLD = 0.85

/** 构造一条 score 答案。 */
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

/** 全达标：每个 score 落在最高档。 */
const ALL_PASS = Object.fromEntries(SCORE_QUESTION_IDS.map(id => [id, score(4, { '4': 1 })]))

test('问题表为 1 个 noul + 10 个 score，顺序与定义一致', () => {
    const questions = decisionQuestions()
    assert.equal(questions[DECISION_QUESTION_ID].type, 'noul')
    const ids = Object.keys(questions).filter(id => id !== DECISION_QUESTION_ID)
    assert.deepEqual(ids, [...SCORE_QUESTION_IDS])
    for (const id of SCORE_QUESTION_IDS) {
        const question = questions[id]
        assert.equal(question.type, 'score')
        assert.equal(typeof question.instructions, 'string')
        // 每个 score 问题必须声明 SCORE_LEVELS 个档位，解析才能按该档数取值
        const criteria = question.criteria
        assert.ok(Array.isArray(criteria), `${id} 缺少 criteria`)
        assert.equal(criteria.length, SCORE_LEVELS, `${id} 档位数应为 ${SCORE_LEVELS}`)
        for (const text of criteria) assert.equal(typeof text, 'string')
    }
})

test('总判定问题不带档位说明', () => {
    const questions = decisionQuestions()
    assert.equal(questions[DECISION_QUESTION_ID].criteria, undefined)
})

test('全部通过则放行', () => {
    const verdict = judge(response(0.95, ALL_PASS), THRESHOLD)
    assert.deepEqual(verdict as unknown, { kind: 'allow' })
})

test('noul 未达阈值则拒绝', () => {
    const verdict = judge(response(0.84, ALL_PASS), THRESHOLD)
    assert.equal(verdict.kind, 'deny')
    assert.ok((verdict as { reason: string }).reason.includes('未通过安全审查'))
})

test('不可商量未达标则拒绝', () => {
    const verdict = judge(response(0.95, { ...ALL_PASS, malice: score(0, { '0': 1 }) }), THRESHOLD)
    assert.equal(verdict.kind, 'deny')
    assert.ok((verdict as { reason: string }).reason.includes('恶意意图'))
})

test('可商量未达标则询问用户', () => {
    const verdict = judge(response(0.95, { ...ALL_PASS, safety: score(0, { '0': 1 }) }), THRESHOLD)
    assert.equal(verdict.kind, 'ask')
    const reason = (verdict as { reason: string }).reason
    assert.ok(reason.includes('操作安全性'))
    assert.ok(reason.includes('需要你决定'))
})

test('首个未达标者决定结果，不检查后续', () => {
    // malice 与 safety 都不达标，但 malice 在前：拒绝优先
    const first = judge(response(0.95, { ...ALL_PASS, malice: score(0, { '0': 1 }), safety: score(0, { '0': 1 }) }), THRESHOLD)
    assert.equal((first as { reason: string }).reason.includes('恶意意图'), true, 'malice 决定结果')
    // 只有 safety 不达标时才是询问
    const second = judge(response(0.95, { ...ALL_PASS, safety: score(0, { '0': 1 }) }), THRESHOLD)
    assert.equal((second as { reason: string }).reason.includes('操作安全性'), true)
})

test('有效阈值按因子下调：0.95 因子的问题阈值更松', () => {
    // necessity 因子 0.95 → 有效阈值 0.8075；安全度 0.82 达标
    const pass = judge(response(0.95, { ...ALL_PASS, necessity: score(3.28, { '2': 0.2, '3': 0.5, '4': 0.12 }) }), THRESHOLD)
    assert.equal((pass as { kind: string }).kind, 'allow')
})

test('安全度取 probabilities 中安全档位之和', () => {
    const { safety, estimated } = safetyOf(score(4, { '0': 0.1, '1': 0.2, '2': 0.3, '3': 0.35, '4': 0.05 }))
    assert.equal(estimated, false)
    // 档位 2 起：0.3 + 0.35 + 0.05
    assert.ok(Math.abs(safety - 0.7) < 1e-9)
    assert.ok(safety >= SAFE_LEVEL_START / SCORE_LEVELS)
})

test('缺失 probabilities 时用期望档位估算，且理由可识别', () => {
    const { safety, estimated } = safetyOf(score(3))
    assert.equal(estimated, true)
    assert.ok(Math.abs(safety - 3 / (SCORE_LEVELS - 1)) < 1e-9)

    const verdict = judge(response(0.95, { ...ALL_PASS, safety: score(1) }), THRESHOLD)
    assert.equal(verdict.kind, 'ask')
    assert.ok((verdict as { reason: string }).reason.includes('按期望档位估算'))
})

test('概率总和非空但安全档位缺失时按 0 处理', () => {
    const { safety } = safetyOf(score(0, { '0': 0.5, '1': 0.5 }))
    assert.equal(safety, 0)
})

test('安全度达标但明确安全档在安全侧中的占比不足时不放行', () => {
    // 安全侧 P(2)=0.9、P(3)=0.08、P(4)=0.02 → 安全度 1.00 达标，
    // 但 (P(3)+P(4))/(P(2)+P(3)+P(4)) = 0.10，不足 60%
    const verdict = judge(response(0.95, {
        ...ALL_PASS,
        safety: score(4, { '0': 0, '1': 0, '2': 0.9, '3': 0.08, '4': 0.02 }),
    }), THRESHOLD)
    assert.equal(verdict.kind, 'ask')
    const reason = (verdict as { reason: string }).reason
    assert.ok(reason.includes('明确安全档占比不足'))
    })

test('不可商量问题的明确安全档占比不足直接拒绝', () => {
    const verdict = judge(response(0.95, {
        ...ALL_PASS,
        malice: score(4, { '2': 0.9, '3': 0.08, '4': 0.02 }),
    }), THRESHOLD)
    assert.equal(verdict.kind, 'deny')
    assert.ok((verdict as { reason: string }).reason.includes('明确安全档占比不足'))
})

test('明确安全档占比恰为 60% 时不放行（需高于）', () => {
    // P(2)=0.4、P(3)=0.3、P(4)=0.3 → 占比 0.6/1.0 = 0.6
    const verdict = judge(response(0.95, {
        ...ALL_PASS,
        safety: score(4, { '2': 0.4, '3': 0.3, '4': 0.3 }),
    }), THRESHOLD)
    assert.equal(verdict.kind, 'ask')
})

test('安全侧之外的低档概率不进入占比分母', () => {
    // P(0)=0.9、P(2)=0.4、P(3)=0.3、P(4)=0.3 → 安全侧总量 1.0，占比 0.6
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
