import assert from 'node:assert/strict'
import { test } from 'node:test'
import { truncateHistory } from '../src/history.ts'
import { byteLength } from '../src/shared/bytes.ts'
import { RECENT_KEEP } from '../src/shared/config.ts'
import type { HistoricalEntry, ReviewSourceRole } from '../src/types.ts'

/** 测试用的字节预算：取一个宽裕值，避免无关用例被裁剪干扰。 */
const ROOMY = 512 * 1024

/** 占位条目的字节数；比它还小的条目省略反而更占空间，会被钉住保留。 */
const PLACEHOLDER_BYTES = byteLength(JSON.stringify({
    kind: 'omitted',
    role: 'fact',
    count: 12,
    text: '12 history item(s) omitted at this point; their content is unavailable.',
}))

/** 一条带角色与文本的保留条目。 */
function user(role: ReviewSourceRole, text: string): HistoricalEntry {
    return { kind: 'user-message', role, source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

/**
 * 一条历史工具调用，体积明确大于占位，用于验证省略与分层行为。
 * @param path - 参数路径。
 */
function call(path: string): HistoricalEntry {
    return {
        kind: 'tool-call',
        role: 'fact',
        mode: 'native',
        name: 'read',
        arguments: JSON.stringify({ path: `history/${path}/packages/auto-review-decision/docs/notes.md` }),
    }
}

/**
 * 一条体积小于占位的历史工具调用，用于验证钉住保留。
 * @param path - 参数路径。
 */
function tinyCall(path: string): HistoricalEntry {
    return { kind: 'tool-call', role: 'fact', mode: 'native', name: 'read', arguments: `{"p":"${path}"}` }
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

test('超预算时逐层出局，保留较新的', () => {
    const half = Math.floor(ROOMY / 2)
    const entries = [call('a'), bigCall(half), bigCall(half + 100), ...manyFacts(RECENT_KEEP + 1)]
    const result = truncateHistory(entries, ROOMY)
    // 头部非权威层里，两条较旧的依次出局，较新的一条落在预算内被保留。
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

test('占位条目本身计入预算，超限时继续丢弃直到落进额度', () => {
    // 被丢弃段集中在最旧一侧，折叠成少量占位；占位体积必须计入总额。
    const entries = [
        user('user-instruction', 'task'),
        ...Array.from({ length: 40 }, (_, index) => call(`f${String(index)}`)),
        ...manyFacts(RECENT_KEEP + 1),
    ]
    const budget = 4200
    const result = truncateHistory(entries, budget)
    assert.ok(byteLength(JSON.stringify(result)) <= budget, '渲染结果应落在预算内')
    assert.equal(omittedCounts(result).length, 1)
})

test('底线自身超限时，全留并如实超出预算', () => {
    // 末十条与待审调用不可剪裁：仅它们就超限时，结果如实越限，由调用方降级。
    const entries = [
        user('user-instruction', 'task'),
        ...Array.from({ length: RECENT_KEEP + 1 }, () => bigCall(ROOMY)),
    ]
    const result = truncateHistory(entries, ROOMY)
    assert.ok(byteLength(JSON.stringify(result)) > ROOMY)
    assert.deepEqual(omittedCounts(result), [])
    assert.equal(result.filter(entry => entry.kind === 'tool-call').length, RECENT_KEEP + 1)
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

test('条目数超过旧窗口上限时，预算内全部保留', () => {
    // 旧的按条目数限流（128 条）已移除：字节预算放得下就全留，不论条数。
    const entries = [user('user-instruction', 'task'), ...manyFacts(300)]
    const result = truncateHistory(entries, ROOMY)
    assert.equal(result.filter(entry => entry.kind === 'tool-call').length, 300)
    assert.deepEqual(omittedCounts(result), [])
})

test('中间权威在中间非权威出尽后才出局，层内从旧到新', () => {
    const entries = [
        user('user-instruction', 'task'),
        ...manyFacts(15),
        ...Array.from({ length: 5 }, (_, index) => user('constraint', `rule ${String(index)}`)),
        ...manyFacts(RECENT_KEEP + 1),
    ]
    const result = truncateHistory(entries, 3750)
    // 中间非权威全出局；中间权威自最旧起 c0、c1 出局，余下保留。
    assert.deepEqual(omittedCounts(result), [7])
    assert.equal(result.filter(entry => entry.kind === 'user-message' && entry.role === 'constraint').length, 3)
})

test('头部非权威是最后出局的层', () => {
    const entries = [
        user('user-instruction', 'task'),
        ...manyFacts(10),
        ...Array.from({ length: 10 }, (_, index) => call(`f${String(index + 10)}`)),
        ...Array.from({ length: 5 }, (_, index) => user('constraint', `rule ${String(index)}`)),
        ...manyFacts(RECENT_KEEP + 1),
    ]
    const result = truncateHistory(entries, 3000)
    // 中间两层全出局后，头部非权威才从最旧起出局；头部权威与末十条不动。
    assert.deepEqual(omittedCounts(result), [4, 15])
    assert.equal(label(result[0]!), 'user-message:user-instruction')
})

test('四类权威角色在裁剪中保留', () => {
    const roles: ReviewSourceRole[] = [
        'user-instruction',
        'direct-parent-instruction',
        'constraint',
        'checkpoint',
    ]
    const entries = [...roles.map(role => user(role, role)), ...manyFacts(64)]
    const result = truncateHistory(entries, 5000)
    const keptRoles = result.flatMap(entry => entry.kind === 'user-message' ? [entry.role] : [])
    assert.deepEqual(keptRoles, roles)
})

test('缺口按连续段分别折叠，被保留条目隔开', () => {
    const entries = [
        user('user-instruction', 'task'),
        ...manyFacts(9),
        call('f9'),
        user('constraint', 'rule 0'),
        call('f10'),
        user('constraint', 'rule 1'),
        ...Array.from({ length: 3 }, (_, index) => call(`f${String(11 + index)}`)),
        ...manyFacts(RECENT_KEEP + 1),
    ]
    const result = truncateHistory(entries, 3900)
    // 中间非权威出局三条，被保留的权威隔开，故有两处占位。
    assert.deepEqual(omittedCounts(result), [1, 2])
    assert.equal(label(result[12]!), 'omitted:1')
    assert.equal(label(result[14]!), 'omitted:2')
})

test('最后一条待审调用永不丢弃，即使它单独超出预算', () => {
    const entries = [user('user-instruction', 'task'), bigCall(ROOMY * 2)]
    const result = truncateHistory(entries, ROOMY)
    assert.deepEqual(result.map(label), ['user-message:user-instruction', 'tool-call:fact'])
    assert.deepEqual(omittedCounts(result), [])
})

test('占位说明声明内容不可用，且角色为 fact', () => {
    const entries = [...manyFacts(148), call('pending')]
    const result = truncateHistory(entries, 0)
    // 头部非权威随预算归零全部出局，缺口自第 1 条起。
    const omitted = result[0]
    assert.equal(omitted?.kind, 'omitted')
    assert.equal(omitted?.role, 'fact')
    const count = omitted?.kind === 'omitted' ? omitted.count : 0
    assert.equal(omitted?.kind === 'omitted' ? omitted.text : '',
        `${String(count)} history item(s) omitted at this point; their content is unavailable.`)
    assert.equal(count, omittedCounts(result)[0])
})

test('预算为零时只剩头部权威与末十条', () => {
    const entries = [user('user-instruction', 'task'), ...manyFacts(64)]
    const result = truncateHistory(entries, 0)
    assert.equal(label(result[0]!), 'user-message:user-instruction')
    assert.equal(result.filter(entry => entry.kind === 'tool-call').length, PROTECTED)
    assert.deepEqual(omittedCounts(result), [53])
})

test('历史过短时末十覆盖全部，永不剪裁', () => {
    const entries = [user('user-instruction', 'task'), ...manyFacts(9)]
    assert.deepEqual(truncateHistory(entries, 0), entries)
})

test('空历史返回空序列', () => {
    assert.deepEqual(truncateHistory([], ROOMY), [])
})

test('只有权威角色时不产生占位', () => {
    const entries = [user('user-instruction', 'a'), user('checkpoint', 'b')]
    assert.deepEqual(omittedCounts(truncateHistory(entries, ROOMY)), [])
    assert.deepEqual(truncateHistory(entries, ROOMY), entries)
})

test('比占位还小的条目被钉住保留，不折叠成占位', () => {
    // 三条极小 fact 加上权威条目，整体远小于预算；它们不该变成占位。
    const entries = [
        user('user-instruction', 'task'),
        tinyCall('a'),
        tinyCall('b'),
        tinyCall('c'),
        ...manyFacts(RECENT_KEEP + 1),
    ]
    const result = truncateHistory(entries, ROOMY)
    assert.deepEqual(omittedCounts(result), [])
    assert.equal(result.filter(entry => entry.kind === 'tool-call').length, RECENT_KEEP + 1 + 3)
    // 小条目按原样保留，未被替换。
    assert.deepEqual(result.slice(1, 4), [tinyCall('a'), tinyCall('b'), tinyCall('c')])
})

test('钉住的小条目不计入占位开销', () => {
    // 同样预算下，含小条目的结果应比把它们省略更省：钉住后无占位。
    const entries = [user('user-instruction', 'task'), tinyCall('a'), ...manyFacts(RECENT_KEEP + 1)]
    const result = truncateHistory(entries, ROOMY)
    assert.deepEqual(omittedCounts(result), [])
    const tinyBytes = byteLength(JSON.stringify(tinyCall('a')))
    assert.ok(tinyBytes <= PLACEHOLDER_BYTES, '该条目的确小于占位')
})

test('已开启缺口时，紧随的小条目仍被省略而非钉住', () => {
    // 首个大条目触发省略，其后的小条目续接同一缺口段。
    const entries = [
        user('user-instruction', 'task'),
        call('big'),
        tinyCall('a'),
        tinyCall('b'),
        ...manyFacts(RECENT_KEEP + 1),
    ]
    const result = truncateHistory(entries, 1024)
    assert.deepEqual(omittedCounts(result), [3])
})

test('大条目按省略处理，与钉住的小条目形成两段不同行为', () => {
    const entries = [
        user('user-instruction', 'task'),
        tinyCall('a'),
        call('big'),
        tinyCall('b'),
        ...manyFacts(RECENT_KEEP + 1),
    ]
    const result = truncateHistory(entries, 2048)
    // tinyCall('a') 钉住保留；call('big') 与 tinyCall('b') 连成一段缺口。
    assert.equal(result[1]?.kind, 'tool-call')
    assert.deepEqual(omittedCounts(result), [2])
})
