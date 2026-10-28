import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateArgs } from '../src/args-schema.ts'

/** 一个典型工具的参数定义。 */
const SCHEMA = {
    type: 'object',
    properties: {
        command: { type: 'string' },
        timeout: { type: 'integer' },
        mode: { type: 'string', enum: ['auto', 'manual'] },
        tags: { type: 'array', items: { type: 'string' } },
        target: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    required: ['command'],
}

test('合法参数通过', () => {
    const issues = validateArgs({ command: 'ls', timeout: 5, mode: 'auto', tags: ['a'], target: { path: '/p' } }, SCHEMA)
    assert.deepEqual(issues, [])
})

test('缺失必填参数', () => {
    const issues = validateArgs({}, SCHEMA)
    assert.equal(issues.length, 1)
    assert.ok(issues[0]?.message.includes('command'))
})

test('类型不符', () => {
    const issues = validateArgs({ command: 'ls', timeout: 'soon' }, SCHEMA)
    assert.ok(issues.some(issue => issue.message.includes('timeout') && issue.message.includes('integer')))
})

test('enum 取值非法', () => {
    const issues = validateArgs({ command: 'ls', mode: 'autox' }, SCHEMA)
    assert.ok(issues.some(issue => issue.message.includes('mode') && issue.message.includes('允许的取值')))
})

test('数组元素类型不符', () => {
    const issues = validateArgs({ command: 'ls', tags: ['a', 3] }, SCHEMA)
    assert.ok(issues.some(issue => issue.path.includes('tags[1]')))
})

test('嵌套对象必填缺失', () => {
    const issues = validateArgs({ command: 'ls', target: {} }, SCHEMA)
    assert.ok(issues.some(issue => issue.message.includes('path')))
})

test('参数不是对象时按声明类型判定', () => {
    const issues = validateArgs('ls', SCHEMA)
    assert.equal(issues.length, 1)
    assert.ok(issues[0]?.message.includes('object'))
})

test('schema 非对象时无从确证违约，交模型侧兜底', () => {
    assert.deepEqual(validateArgs({ command: 'ls' }, undefined), [])
    assert.deepEqual(validateArgs({ command: 'ls' }, 'not-a-schema'), [])
})

test('多类型声明', () => {
    const schema = { type: 'object', properties: { value: { type: ['string', 'null'] } } }
    assert.deepEqual(validateArgs({ value: null }, schema), [])
    assert.deepEqual(validateArgs({ value: 3 }, schema).length, 1)
})
