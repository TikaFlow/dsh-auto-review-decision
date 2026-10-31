import assert from 'node:assert/strict'
import { test } from 'node:test'
import { truncateHistory } from '../src/history.ts'
import { byteLength } from '../src/shared/bytes.ts'
import { HISTORY_WINDOW, RECENT_KEEP } from '../src/shared/config.ts'
import type { HistoricalEntry, ReviewSourceRole } from '../src/types.ts'

/** 测试用的字节预算：取一个宽裕值，避免无关用例被裁剪干扰。 */
const ROOMY = 512 * 1024

/** 一条带角色与文本的保留条目。 */
function user(role: ReviewSourceRole, text: string): HistoricalEntry {
    return { kind: 'user-message', role, source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

/** 一条历史工具调用。 */
function call(path: string): HistoricalEntry {
    return { kind: 'tool-call', role: 'fact', mode: 'native', name: 'read', arguments: `{"path":"${path}"}` }
}

/** 一条参数为指定 ASCII 长度的历史工具调用。 */
function bigCall(size: number): HistoricalEntry {
    return { kind: 'tool-call', role: 'fact', mode: 'native', name: 'read', arguments: 'x'.repeat(size) }
}

/** 一条参数为指定汉字个数的历史工具调用。 */
function bigCjkCall(size: number): HistoricalEntry {
    return { kind: 'tool-call', role: 'fact', mode: 'native', name: 'read', arguments: '中'.repeat(size) }
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

/** 待审调用与它之前的若干条历史构成的保护区长度。 */
const PROTECTED = RECENT_KEEP + 1

test('未超限时原样返回，不插入占位', () => {
    const entries = [user('user-instruction', 'task'), call('a'), call('b')]
    assert.deepEqual(truncateHistory(entries, ROOMY), entries)
    assert.deepEqual(omittedCounts(truncateHistory(entries, ROOMY)), [])
})

test('最近若干条历史与待审调用一律保留，不论角色', () => {
    // 预算被前面的巨型 fact 吃光，末尾 10 条 fact 与待审调用仍须全留。
    const entries = [
        user('user-instruction', 'task'),
        ...Array.from({ length: 20 }, () => bigCall(ROOMY)),
        ...manyFacts(RECENT_KEEP + 1),
    ]
    const result = truncateHistory(entries, ROOMY)
    const tail = result.slice(-PROTECTED)
    assert.equal(tail.length, PROTECTED)
    assert.ok(tail.every(entry => entry.kind === 'tool-call'))
    assert.equal(tail.at(-1)?.kind, 'tool-call')
})

test('保护区外放不下时，可丢弃条目全部折叠为占位', () => {
    const entries = [
        user('user-instruction', 'task'),
        ...Array.from({ length: 20 }, () => bigCall(ROOMY)),
        ...manyFacts(RECENT_KEEP + 1),
    ]
    const result = truncateHistory(entries, ROOMY)
    assert.deepEqual(result.map(label).slice(0, 2), ['user-message:user-instruction', 'omitted:20'])
})

test('超预算时从最旧一条起逐条出局，保留较新的', () => {
    const half = Math.floor(ROOMY / 2)
    const entries = [call('a'), bigCall(half), bigCall(half + 100), ...manyFacts(RECENT_KEEP + 1)]
    const result = truncateHistory(entries, ROOMY)
    // 保护区外的三条里，两条较旧的依次出局，较新的一条落在预算内被保留。
    assert.deepEqual(result.map(label).slice(0, 2), ['omitted:2', 'tool-call:fact'])
    const survivor = result[1]
    assert.equal(survivor?.kind === 'tool-call' ? survivor.arguments.length : 0, half + 100)
    assert.equal(result.filter(entry => entry.kind === 'tool-call').length, PROTECTED + 1)
})

test('保护区外余下的 fact 在预算内时保留', () => {
    const entries = [call('a'), bigCall(Math.floor(ROOMY / 2)), ...manyFacts(RECENT_KEEP + 1)]
    const result = truncateHistory(entries, ROOMY)
    assert.deepEqual(omittedCounts(result), [])
    assert.equal(result.filter(entry => entry.kind === 'tool-call').length, PROTECTED + 2)
})

test('单条超大 fact 不再连带清空更早的权威条目', () => {
    const entries = [
        user('user-instruction', 'task'),
        call('a'),
        bigCall(ROOMY * 2),
        ...manyFacts(RECENT_KEEP + 1),
    ]
    const result = truncateHistory(entries, ROOMY)
    assert.deepEqual(result.map(label).slice(0, 2), ['user-message:user-instruction', 'omitted:2'])
})

test('按 UTF-8 字节计：同样字数下中文条目比 ASCII 更快耗尽预算', () => {
    const size = 4096
    const asciiBytes = byteLength(JSON.stringify(bigCall(size)))
    const cjkBytes = byteLength(JSON.stringify(bigCjkCall(size)))
    assert.ok(cjkBytes > asciiBytes * 2, '中文条目应显著更大')
    // 预算取两者中点：ASCII 版本放得下，等长中文版本放不下。
    const budget = Math.floor((asciiBytes + cjkBytes) / 2)
    const asciiRun = truncateHistory([bigCall(size), ...manyFacts(RECENT_KEEP + 1)], budget)
    const cjkRun = truncateHistory([bigCjkCall(size), ...manyFacts(RECENT_KEEP + 1)], budget)
    assert.deepEqual(omittedCounts(asciiRun), [])
    assert.deepEqual(omittedCounts(cjkRun), [1])
})

test('窗口只统计可丢弃条目，权威角色不占名额', () => {
    const entries = [user('user-instruction', 'task'), ...manyFacts(HISTORY_WINDOW + 20)]
    const result = truncateHistory(entries, ROOMY)
    assert.equal(label(result[0]!), 'user-message:user-instruction')
    assert.equal(result.filter(entry => entry.kind === 'tool-call').length, HISTORY_WINDOW + PROTECTED)
    assert.deepEqual(omittedCounts(result), [entries.length - PROTECTED - HISTORY_WINDOW - 1])
})

test('超出窗口的权威角色不被丢弃', () => {
    const entries = [user('user-instruction', 'task'), ...manyFacts(HISTORY_WINDOW * 2)]
    const result = truncateHistory(entries, ROOMY)
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
    const result = truncateHistory(entries, ROOMY)
    const keptRoles = result.flatMap(entry => entry.kind === 'user-message' ? [entry.role] : [])
    assert.deepEqual(keptRoles, roles)
})

test('缺口按连续段分别折叠，位置与原文对齐', () => {
    const entries = [call('a'), call('b'), user('user-instruction', 'task'), ...manyFacts(HISTORY_WINDOW + 20)]
    const result = truncateHistory(entries, ROOMY)
    // 前两条 fact 与紧随其后被裁掉的 fact 被权威条目隔开，故有两处占位。
    assert.equal(omittedCounts(result).length, 2)
    assert.equal(label(result[0]!), 'omitted:2')
    assert.equal(label(result[1]!), 'user-message:user-instruction')
})

test('最后一条待审调用永不丢弃，即使它单独超出预算', () => {
    const entries = [user('user-instruction', 'task'), bigCall(ROOMY * 2)]
    const result = truncateHistory(entries, ROOMY)
    assert.deepEqual(result.map(label), ['user-message:user-instruction', 'tool-call:fact'])
    assert.deepEqual(omittedCounts(result), [])
})

test('占位说明声明内容不可用，且角色为 fact', () => {
    const entries = [...manyFacts(HISTORY_WINDOW + 20), call('pending')]
    const [omitted] = truncateHistory(entries, ROOMY)
    assert.equal(omitted?.kind, 'omitted')
    assert.equal(omitted?.role, 'fact')
    const count = omitted?.kind === 'omitted' ? omitted.count : 0
    assert.equal(omitted?.kind === 'omitted' ? omitted.text : '',
        `${String(count)} history item(s) omitted at this point; their content is unavailable.`)
    assert.equal(count, omittedCounts(truncateHistory(entries, ROOMY))[0])
})

test('预算为零时只有权威角色与保护区留下', () => {
    const entries = [user('user-instruction', 'task'), ...manyFacts(HISTORY_WINDOW)]
    const result = truncateHistory(entries, 0)
    assert.equal(result.filter(entry => entry.kind === 'tool-call').length, PROTECTED)
    assert.equal(omittedCounts(result).length, 1)
})

test('空历史返回空序列', () => {
    assert.deepEqual(truncateHistory([], ROOMY), [])
})

test('只有权威角色时不产生占位', () => {
    const entries = [user('user-instruction', 'a'), user('checkpoint', 'b')]
    assert.deepEqual(omittedCounts(truncateHistory(entries, ROOMY)), [])
    assert.deepEqual(truncateHistory(entries, ROOMY), entries)
})
