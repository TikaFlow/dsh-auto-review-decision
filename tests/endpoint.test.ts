import assert from 'node:assert/strict'
import { test } from 'node:test'
import { baseURLProblem, decisionEndpoint } from '../src/shared/config.ts'

test('默认追加 /systemone', () => {
    assert.equal(decisionEndpoint('https://example.com/v1', false), 'https://example.com/v1/systemone')
})

test('完整 URL 不追加路径', () => {
    assert.equal(decisionEndpoint('https://example.com/v1/systemone', true), 'https://example.com/v1/systemone')
})

test('末尾斜杠一律去除', () => {
    assert.equal(decisionEndpoint('https://example.com/v1/', false), 'https://example.com/v1/systemone')
    assert.equal(decisionEndpoint('https://example.com/v1///', false), 'https://example.com/v1/systemone')
    assert.equal(decisionEndpoint('https://example.com/v1/systemone/', true), 'https://example.com/v1/systemone')
})

test('路径是否含 /systemone 不参与校验', () => {
    assert.equal(baseURLProblem('https://example.com/v1/systemone'), undefined)
    assert.equal(baseURLProblem('https://example.com/v1'), undefined)
})

test('拒绝查询串、片段与非法协议', () => {
    assert.ok(baseURLProblem('https://example.com/v1?x=1') !== undefined)
    assert.ok(baseURLProblem('https://example.com/v1#a') !== undefined)
    assert.ok(baseURLProblem('ftp://example.com/v1') !== undefined)
    assert.ok(baseURLProblem('not-a-url') !== undefined)
})

test('空串视为未配置而非非法', () => {
    assert.equal(baseURLProblem(''), undefined)
})
