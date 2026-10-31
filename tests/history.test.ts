import assert from 'node:assert/strict'
import { test } from 'node:test'
import { truncateHistory } from '../src/history.ts'
import { HISTORY_CHAR_BUDGET, HISTORY_WINDOW } from '../src/shared/config.ts'
import type { HistoricalEntry, ReviewSourceRole } from '../src/types.ts'

/** 一条带角色与文本的保留条目。 */
function user(role: ReviewSourceRole, text: string): HistoricalEntry {
    return { kind: 'user-message', role, source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

/** 一条历史工具调用。 */
function call(path: string): HistoricalEntry {
    return { kind: 'tool-call', role: 'fact', mode: 'native', name: 'read', arguments: `{"path":"${path}"}` }
}

/** 一条指定长度的历史工具调用。 */
function bigCall(size: number): HistoricalEntry {
    return { kind: 'tool-call', role: 'fact', mode: 'native', name: 'read', arguments: 'x'.repeat(size) }
}

/** 条目的简短标识：占位显示为 omitted:数量，其余为 kind:role。 */
function label(entry: HistoricalEntry): string {
    return entry.kind === 'omitted' ? `omitted:${String(entry.count)}` : `${entry.kind}:${entry.role}`
}

/** 取全部占位的省略数量。 */
function omittedCounts(entries: readonly HistoricalEntry[]): number[] {
    return entries.flatMap(entry => entry.kind === 'omitted' ? [entry.count] : [])
}

/** 构造 N 条 fact，最后一条是待审调用。 */
function manyFacts(count: number): HistoricalEntry[] {
    return Array.from({ length: count }, (_, index) => call(`f${String(index)}`))
}

test('未超限时原样返回，不插入占位', () => {
    const entries = [user('user-instruction', 'task'), call('a'), call('b')]
    assert.deepEqual(truncateHistory(entries), entries)
    assert.deepEqual(omittedCounts(truncateHistory(entries)), [])
})

test('窗口只统计可丢弃条目，权威角色不占名额', () => {
    const entries = [user('user-instruction', 'task'), ...manyFacts(HISTORY_WINDOW + 6)]
    const result = truncateHistory(entries)
    // 指令仍在首位，其后是 5 条被折叠的缺口，再是最近 128 条 fact 与末条待审调用。
    assert.equal(label(result[0]!), 'user-message:user-instruction')
    assert.deepEqual(omittedCounts(result), [5])
    assert.equal(result.filter(entry => entry.kind === 'tool-call').length, HISTORY_WINDOW + 1)
})

test('超出窗口的权威角色不被丢弃', () => {
    const entries = [user('user-instruction', 'task'), ...manyFacts(HISTORY_WINDOW * 2)]
    const result = truncateHistory(entries)
    assert.equal(result[0]!.kind, 'user-message')
    assert.equal(omittedCounts(result).length, 1)
})

test('四类权威角色都在裁剪中保留', () => {
    const roles: ReviewSourceRole[] = [
        'user-instruction',
        'direct-parent-instruction',
        'constraint',
        'checkpoint',
    ]
    const entries = [...roles.map(role => user(role, role)), ...manyFacts(HISTORY_WINDOW * 2)]
    const result = truncateHistory(entries)
    const keptRoles = result.flatMap(entry => entry.kind === 'user-message' ? [entry.role] : [])
    assert.deepEqual(keptRoles, roles)
})

test('缺口按连续段分别折叠，位置与原文对齐', () => {
    const entries = [call('a'), call('b'), user('user-instruction', 'task'), ...manyFacts(HISTORY_WINDOW + 4)]
    const result = truncateHistory(entries)
    // 前两条 fact 与紧随其后的 3 条被权威条目隔开，故有两处占位。
    assert.deepEqual(omittedCounts(result), [2, 3])
    assert.equal(label(result[0]!), 'omitted:2')
    assert.equal(label(result[1]!), 'user-message:user-instruction')
})

test('字符预算超限时从最旧一条起依次出局', () => {
    const half = Math.floor(HISTORY_CHAR_BUDGET / 2) - 10
    const entries = [call('a'), bigCall(half), bigCall(half), call('pending')]
    const result = truncateHistory(entries)
    // 两条半预算 fact 合计超限，最旧两条依次出局，较新一条与末条待审调用保留。
    assert.deepEqual(result.map(label), ['omitted:2', 'tool-call:fact', 'tool-call:fact'])
})

test('单条超大 fact 不再连带清空更早的权威条目', () => {
    const entries = [user('user-instruction', 'task'), call('a'), bigCall(HISTORY_CHAR_BUDGET * 2), call('pending')]
    const result = truncateHistory(entries)
    assert.deepEqual(result.map(label), ['user-message:user-instruction', 'omitted:2', 'tool-call:fact'])
})

test('最后一条待审调用永不丢弃，即使它单独超出预算', () => {
    const entries = [user('user-instruction', 'task'), bigCall(HISTORY_CHAR_BUDGET * 2)]
    const result = truncateHistory(entries)
    assert.deepEqual(result.map(label), ['user-message:user-instruction', 'tool-call:fact'])
    assert.deepEqual(omittedCounts(result), [])
})

test('占位说明声明内容不可用，且角色为 fact', () => {
    const entries = [...manyFacts(HISTORY_WINDOW + 1), call('pending')]
    const [omitted] = truncateHistory(entries)
    assert.equal(omitted?.kind, 'omitted')
    assert.equal(omitted?.role, 'fact')
    assert.equal(omitted?.text, '1 history item(s) omitted at this point; their content is unavailable.')
})

test('空历史返回空序列', () => {
    assert.deepEqual(truncateHistory([]), [])
})

test('只有权威角色时不产生占位', () => {
    const entries = [user('user-instruction', 'a'), user('checkpoint', 'b')]
    assert.deepEqual(omittedCounts(truncateHistory(entries)), [])
    assert.deepEqual(truncateHistory(entries), entries)
})
