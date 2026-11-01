import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixedStateBytes } from '../src/fixed-overhead.ts'
import { byteLength } from '../src/shared/bytes.ts'

/** 一个最小的固定部分组合。 */
const PARTS = {
    environment: { cwd: '/workspace' },
    policy: 'REVIEW_POLICY text',
    pending: { name: 'read', arguments: { path: 'a.ts' } },
    questions: {
        allow: { type: 'noul', instructions: 'should it run?' },
        scope: { type: 'score', instructions: 'in scope?', criteria: ['no', 'yes'] },
    },
}

test('固定开销等于 environment + policy + pending + 最长单个问题', () => {
    const longest = Math.max(
        byteLength(JSON.stringify(PARTS.questions.allow)),
        byteLength(JSON.stringify(PARTS.questions.scope)),
    )
    const expected = byteLength(JSON.stringify(PARTS.environment))
        + byteLength(PARTS.policy)
        + byteLength(JSON.stringify(PARTS.pending))
        + longest
    assert.equal(fixedStateBytes(PARTS), expected)
})

test('questions 只计入最长一个，不按整份表求和', () => {
    const onlyScope = fixedStateBytes({
        ...PARTS,
        questions: { scope: PARTS.questions.scope },
    })
    // scope 是较长的那道题，去掉 allow 后结果不变。
    assert.equal(fixedStateBytes(PARTS), onlyScope)

    const allSum = Object.values(PARTS.questions).reduce((sum, q) => sum + byteLength(JSON.stringify(q)), 0)
    const longest = Math.max(...Object.values(PARTS.questions).map(q => byteLength(JSON.stringify(q))))
    assert.ok(allSum > longest)
})

test('问题表为空时不计 question 部分', () => {
    const empty = fixedStateBytes({ ...PARTS, questions: {} })
    const expected = byteLength(JSON.stringify(PARTS.environment))
        + byteLength(PARTS.policy)
        + byteLength(JSON.stringify(PARTS.pending))
    assert.equal(empty, expected)
})

test('policy 按 UTF-8 字节计，中文政策文本更大', () => {
    const ascii = fixedStateBytes({ ...PARTS, policy: 'x'.repeat(100) })
    const cjk = fixedStateBytes({ ...PARTS, policy: '中'.repeat(100) })
    assert.ok(cjk > ascii)
})

test('pending 随参数增大而增大', () => {
    const small = fixedStateBytes({ ...PARTS, pending: { name: 'read', arguments: {} } })
    const big = fixedStateBytes({
        ...PARTS,
        pending: { name: 'read', arguments: { content: 'x'.repeat(1000) } },
    })
    assert.ok(big > small)
    assert.equal(big - small, byteLength(JSON.stringify({ content: 'x'.repeat(1000) }))
        - byteLength(JSON.stringify({})))
})

test('environment 计入 cwd', () => {
    const short = fixedStateBytes({ ...PARTS, environment: { cwd: '/a' } })
    const long = fixedStateBytes({ ...PARTS, environment: { cwd: `/a/${'b'.repeat(100)}` } })
    assert.ok(long > short)
})
