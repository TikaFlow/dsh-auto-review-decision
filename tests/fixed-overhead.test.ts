import assert from 'node:assert/strict'
import { test } from 'node:test'
import { serializeFixedState } from '../src/fixed-overhead.ts'
import { byteLength } from '../src/shared/bytes.ts'

/** 固定开销的字节数：取自同一次序列化结果。 */
function fixedBytes(parts: Parameters<typeof serializeFixedState>[0]): number {
    return serializeFixedState(parts).bytes
}

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

test('固定开销等于外壳 + environment + policy + pending + 全部问题', () => {
    // state 外壳 48 与 history 空数组括号 2。
    const expected = 50
        + byteLength(JSON.stringify(PARTS.environment))
        + byteLength(JSON.stringify(PARTS.policy))
        + byteLength(JSON.stringify(PARTS.pending))
        + byteLength(JSON.stringify(PARTS.questions))
    assert.equal(fixedBytes(PARTS), expected)
})

test('questions 按整份表计入，而非只计最长一个', () => {
    const onlyScope = fixedBytes({
        ...PARTS,
        questions: { scope: PARTS.questions.scope },
    })
    // 去掉较短的那道题后结果变小，说明按整份表求和。
    assert.ok(fixedBytes(PARTS) > onlyScope)

    const allSum = Object.values(PARTS.questions).reduce((sum, q) => sum + byteLength(JSON.stringify(q)), 0)
    const longest = Math.max(...Object.values(PARTS.questions).map(q => byteLength(JSON.stringify(q))))
    assert.ok(allSum > longest)
})

test('问题表为空时只余下空对象与外壳的字节', () => {
    const empty = fixedBytes({ ...PARTS, questions: {} })
    const expected = 50
        + byteLength(JSON.stringify(PARTS.environment))
        + byteLength(JSON.stringify(PARTS.policy))
        + byteLength(JSON.stringify(PARTS.pending))
        + byteLength(JSON.stringify({}))
    assert.equal(empty, expected)
})

test('policy 按 UTF-8 字节计，中文政策文本更大', () => {
    const ascii = fixedBytes({ ...PARTS, policy: 'x'.repeat(100) })
    const cjk = fixedBytes({ ...PARTS, policy: '中'.repeat(100) })
    assert.ok(cjk > ascii)
})

test('pending 随参数增大而增大', () => {
    const small = fixedBytes({ ...PARTS, pending: { name: 'read', arguments: {} } })
    const big = fixedBytes({
        ...PARTS,
        pending: { name: 'read', arguments: { content: 'x'.repeat(1000) } },
    })
    assert.ok(big > small)
    assert.equal(big - small, byteLength(JSON.stringify({ content: 'x'.repeat(1000) }))
        - byteLength(JSON.stringify({})))
})

test('environment 计入 cwd', () => {
    const short = fixedBytes({ ...PARTS, environment: { cwd: '/a' } })
    const long = fixedBytes({ ...PARTS, environment: { cwd: `/a/${'b'.repeat(100)}` } })
    assert.ok(long > short)
})

test('返回的文本即请求体片段，与逐部分序列化一致', () => {
    const serialized = serializeFixedState(PARTS)
    assert.equal(serialized.environment, JSON.stringify(PARTS.environment))
    assert.equal(serialized.policy, JSON.stringify(PARTS.policy))
    assert.equal(serialized.pending, JSON.stringify(PARTS.pending))
    assert.equal(serialized.questions, JSON.stringify(PARTS.questions))
})
