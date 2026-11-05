import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readReviewConfig } from '../src/config.ts'
import { DEFAULT_CONFIG, MAX_CONTEXT_TOKENS, MIN_CONTEXT_TOKENS, parseContextTokens } from '../src/shared/config.ts'

test('parseContextTokens 接受纯正整数与 K/M 单位', () => {
    assert.equal(parseContextTokens('24576'), 24576)
    assert.equal(parseContextTokens('8192'), 8192)
    assert.equal(parseContextTokens('24K'), 24 * 1024)
    assert.equal(parseContextTokens('24k'), 24 * 1024)
    assert.equal(parseContextTokens('1M'), 1024 * 1024)
    assert.equal(parseContextTokens('1m'), 1024 * 1024)
})

test('parseContextTokens 拒绝空格、额外后缀、小数与符号', () => {
    assert.equal(parseContextTokens('24 K'), undefined)
    assert.equal(parseContextTokens('24KB'), undefined)
    assert.equal(parseContextTokens('1.5K'), undefined)
    assert.equal(parseContextTokens('-5'), undefined)
    assert.equal(parseContextTokens('+5'), undefined)
    assert.equal(parseContextTokens('K'), undefined)
    assert.equal(parseContextTokens(''), undefined)
})

test('parseContextTokens 边界：4096 与 1048576 合法，两侧越界非法', () => {
    assert.equal(parseContextTokens('4096'), 4096)
    assert.equal(parseContextTokens('4095'), undefined)
    assert.equal(parseContextTokens('1048576'), 1048576)
    assert.equal(parseContextTokens('1048577'), undefined)
    assert.equal(parseContextTokens('0'), undefined)
    assert.equal(parseContextTokens(String(MIN_CONTEXT_TOKENS - 1)), undefined)
    assert.equal(parseContextTokens(String(MAX_CONTEXT_TOKENS + 1)), undefined)
    assert.equal(parseContextTokens('1025K'), undefined)
    assert.equal(parseContextTokens('9007199254740993K'), undefined)
})

test('readReviewConfig 默认值与缺失落默认', () => {
    const withDefault = readReviewConfig(undefined)
    assert.equal(withDefault.values.contextTokens, DEFAULT_CONFIG.contextTokens)
    const withMissing = readReviewConfig({})
    assert.equal(withMissing.values.contextTokens, DEFAULT_CONFIG.contextTokens)
})

test('readReviewConfig 接受合法上下文窗口', () => {
    for (const contextTokens of [MIN_CONTEXT_TOKENS, 100000, MAX_CONTEXT_TOKENS]) {
        assert.equal(readReviewConfig({ contextTokens }).values.contextTokens, contextTokens)
    }
})

test('readReviewConfig 拒绝字符串、非整数与越界', () => {
    assert.throws(() => readReviewConfig({ contextTokens: '24576' }), /contextTokens/)
    assert.throws(() => readReviewConfig({ contextTokens: 24.5 }), /contextTokens/)
    assert.throws(() => readReviewConfig({ contextTokens: MIN_CONTEXT_TOKENS - 1 }), /contextTokens/)
    assert.throws(() => readReviewConfig({ contextTokens: MAX_CONTEXT_TOKENS + 1 }), /contextTokens/)
    assert.throws(() => readReviewConfig({ contextTokens: Number.NaN }), /contextTokens/)
})
