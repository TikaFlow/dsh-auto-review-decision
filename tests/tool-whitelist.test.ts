import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readReviewConfig } from '../src/config.ts'
import { DEFAULT_CONFIG, parseToolWhitelist } from '../src/shared/config.ts'

test('parseToolWhitelist 按逗号分隔并逐项去首尾空白', () => {
    assert.deepEqual(parseToolWhitelist('read, write ,glob'), ['read', 'write', 'glob'])
    assert.deepEqual(parseToolWhitelist('read'), ['read'])
    assert.deepEqual(parseToolWhitelist(''), [])
    assert.deepEqual(parseToolWhitelist('   '), [])
})

test('parseToolWhitelist 丢弃空项而非报错', () => {
    assert.deepEqual(parseToolWhitelist('read,,write'), ['read', 'write'])
    assert.deepEqual(parseToolWhitelist('read,'), ['read'])
    assert.deepEqual(parseToolWhitelist(',read'), ['read'])
    assert.deepEqual(parseToolWhitelist(',,'), [])
    assert.deepEqual(parseToolWhitelist('read, '), ['read'])
})

test('readReviewConfig 默认工具白名单为空表', () => {
    assert.deepEqual(readReviewConfig(undefined).values.toolWhitelist, DEFAULT_CONFIG.toolWhitelist)
    assert.deepEqual(readReviewConfig({}).values.toolWhitelist, [])
})

test('readReviewConfig 接受字符串数组并去首尾空白', () => {
    const parsed = readReviewConfig({ toolWhitelist: [' read ', 'write', ' glob '] })
    assert.deepEqual(parsed.values.toolWhitelist, ['read', 'write', 'glob'])
})

test('readReviewConfig 拒绝非数组与非字符串元素', () => {
    assert.throws(() => readReviewConfig({ toolWhitelist: 'pwsh' }), /toolWhitelist/)
    assert.throws(() => readReviewConfig({ toolWhitelist: ['pwsh', 42] }), /toolWhitelist/)
    assert.throws(() => readReviewConfig({ toolWhitelist: ['pwsh', ' '] }), /toolWhitelist/)
})
