import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { askUser, denied, failed } from '../src/verdict.ts'

/** 最小执行桩：三个落地函数只读取 `exec.name`。 */
function exec(name = 'probe'): ToolExecution {
    return { name } as unknown as ToolExecution
}

/** 收窄到 deny 成员：`info`/`reason` 在联合类型上访问前先定性。 */
function asDeny(decision: PreToolDecision): Extract<PreToolDecision, { kind: 'deny' }> {
    assert.ok(decision.kind === 'deny')
    return decision
}

/** 收窄到 ask 成员：`displayReason` 在联合类型上访问前先定性。 */
function asAsk(decision: PreToolDecision): Extract<PreToolDecision, { kind: 'ask' }> {
    assert.ok(decision.kind === 'ask')
    return decision
}

test('denied 物化为固定结构：deny + 固定英文模板 + 结构化 info', () => {
    const decision = asDeny(denied(exec(), { en: 'reason-en', zh: '原因' }))
    assert.ok(decision.info !== undefined)
    assert.deepEqual(decision, {
        kind: 'deny',
        reason: 'Auto review rejected tool "probe"; its body was not executed',
        info: {
            name: 'AutoReviewDeniedError',
            code: 'AUTO_REVIEW_DENIED',
            reason: 'reason-en',
        },
    })
})

test('denied 的 info.reason 原样保留首尾空白与换行，不改写不截断', () => {
    const raw = '  首尾空白与\n换行  '
    const withRaw = asDeny(denied(exec(), { en: raw, zh: raw }))
    assert.ok(withRaw.info !== undefined)
    assert.equal(withRaw.info.reason, raw)
    const long = '长'.repeat(500)
    const withLong = asDeny(denied(exec(), { en: long, zh: long }))
    assert.ok(withLong.info !== undefined)
    assert.equal(withLong.info.reason, long)
})

test('denied 顶层 reason 是固定模板，原始理由只落在 info.reason', () => {
    const decision = asDeny(denied(exec('runner'), { en: 'secret reasoning', zh: '机密推理细节' }))
    assert.ok(decision.info !== undefined)
    assert.ok(decision.reason.includes('"runner"'))
    assert.ok(!decision.reason.includes('secret reasoning'))
    assert.equal(decision.info.reason, 'secret reasoning')
})

test('askUser 把 deny 落为审批询问，reason 为前缀加英文理由', () => {
    const decision = asAsk(askUser(exec(), { en: 'reason-en', zh: '原因' }))
    assert.equal(decision.reason, 'Auto review denied tool "probe": reason-en')
})

test('askUser 的 displayReason 中英文各自携带对应语言的理由', () => {
    const raw = { en: '  keep spaces \nnewlines', zh: '  保留 空白 \n换行' }
    const decision = asAsk(askUser(exec(), raw))
    assert.ok(decision.displayReason !== undefined)
    assert.equal(decision.displayReason.en, `Auto review denied this call: ${raw.en}`)
    assert.equal(decision.displayReason.zh, `自动审查拒绝了此调用：${raw.zh}`)
})

test('askUser 无理由时落通用询问文案', () => {
    const decision = asAsk(askUser(exec()))
    assert.equal(decision.reason, 'Auto review denied tool "probe"')
    assert.deepEqual(decision.displayReason, {
        en: 'Auto review denied this call.',
        zh: '自动审查拒绝了此调用。',
    })
})

test('failed 物化为独立错误（AutoReviewFailedError）而非审查拒绝，只取 message 不带 stack', () => {
    const error = new Error('端点不可用')
    const decision = asDeny(failed(exec(), error))
    assert.deepEqual(decision, {
        kind: 'deny',
        reason: 'Auto review of tool "probe" failed; its body was not executed: 端点不可用',
        info: { name: 'AutoReviewFailedError', code: 'AUTO_REVIEW_FAILED' },
    })
    assert.ok(!decision.reason.includes(error.stack ?? ''))
})

test('failed 对非 Error 抛值按 String(error) 物化且不崩溃', () => {
    const stringFail = asDeny(failed(exec(), 'plain string'))
    assert.equal(stringFail.reason, 'Auto review of tool "probe" failed; its body was not executed: plain string')
    const numberFail = asDeny(failed(exec(), 42))
    assert.ok(numberFail.reason.endsWith(': 42'))
    const nullFail = asDeny(failed(exec(), null))
    assert.ok(nullFail.reason.endsWith(': null'))
    const undefinedFail = asDeny(failed(exec(), undefined))
    assert.ok(undefinedFail.reason.endsWith(': undefined'))
    const symbolFail = asDeny(failed(exec(), Symbol.for('sym')))
    assert.ok(symbolFail.reason.endsWith(': Symbol(sym)'))
})

test('failed 对对象抛值只物化 String 形态，对象字段不泄漏进工具结果', () => {
    const decision = asDeny(failed(exec('runner'), { apiKey: 'secret-value', detail: 'x' }))
    assert.ok(decision.info !== undefined)
    assert.equal(decision.info.name, 'AutoReviewFailedError')
    assert.ok(!decision.reason.includes('secret-value'))
    assert.ok(!decision.reason.includes('apiKey'))
    assert.ok(!('risk' in decision))
    assert.ok(!('decision' in decision))
})
