import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isAborted, json, loggedSchema, parseLoggedArguments, sameJson } from '../src/log.ts'

test('json 按两空格缩进渲染嵌套值', () => {
    assert.equal(json({ a: 1, b: { c: 'x' } }), '{\n  "a": 1,\n  "b": {\n    "c": "x"\n  }\n}')
})

test('json 对不可序列化值抛错而非静默写坏日志', () => {
    assert.throws(() => json(undefined), /not JSON-serializable/)
    assert.throws(() => json(() => 1), /not JSON-serializable/)
})

test('parseLoggedArguments 空字符串重建为空对象', () => {
    assert.deepEqual(parseLoggedArguments(''), {})
})

test('parseLoggedArguments 合法 JSON 正常解析', () => {
    assert.deepEqual(parseLoggedArguments('{"a":1}'), { a: 1 })
    assert.equal(parseLoggedArguments('42'), 42)
    assert.equal(parseLoggedArguments('"text"'), 'text')
})

test('parseLoggedArguments 非法 JSON 原样透传原始字符串', () => {
    const raw = '{not json'
    assert.equal(parseLoggedArguments(raw), raw)
    assert.equal(parseLoggedArguments(' {"a":1} trailing'), ' {"a":1} trailing')
})

test('sameJson 用字符串化比较：同构同序为真，键序不同与值不同都为假', () => {
    assert.ok(sameJson({ a: 1, b: 2 }, { a: 1, b: 2 }))
    assert.ok(sameJson({ a: { b: [1, 2] } }, { a: { b: [1, 2] } }))
    assert.ok(!sameJson({ a: 1, b: 2 }, { b: 2, a: 1 }))
    assert.ok(!sameJson({ a: 1 }, { a: 2 }))
    assert.ok(!sameJson(1, '1'))
    assert.ok(!sameJson([1, 2], [2, 1]))
})

test('loggedSchema 用调用名组装 schema，日志字段原样保留', () => {
    const value = { description: 'does x', parameters: { type: 'object' } }
    assert.deepEqual(loggedSchema(value, 'probe', 'native'), {
        name: 'probe',
        description: 'does x',
        parameters: { type: 'object' },
    })
})

test('loggedSchema 缺失或错名 description 抛错，消息带模式', () => {
    assert.throws(() => loggedSchema({}, 'probe', 'native'), /the pending native tool schema is incomplete/)
    assert.throws(() => loggedSchema({ description: 42 }, 'probe', 'PTC'), /the pending PTC tool schema is incomplete/)
})

test('loggedSchema 的 parameters 必须是普通对象，null 与数组都算不完整', () => {
    assert.throws(() => loggedSchema({ description: 'x', parameters: null }, 'probe', 'native'), /incomplete/)
    assert.throws(() => loggedSchema({ description: 'x', parameters: [1] }, 'probe', 'native'), /incomplete/)
    assert.throws(() => loggedSchema({ description: 'x', parameters: 'object' }, 'probe', 'PTC'), /incomplete/)
})

test('isAborted 跨 await 读取实时中止状态', async () => {
    const controller = new AbortController()
    assert.ok(!isAborted(controller.signal))
    controller.abort()
    assert.ok(isAborted(controller.signal))
    const late = new AbortController()
    const pending = Promise.resolve().then(() => isAborted(late.signal))
    late.abort()
    assert.ok(await pending)
})
