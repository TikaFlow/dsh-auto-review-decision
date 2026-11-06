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

test('只要求 http 或 https 协议，路径与端口合法', () => {
    for (const value of [
        'http://example.com',
        'https://example.com',
        'https://example.com/v1/chat',
        'https://example.com:8443/v1',
    ]) assert.equal(baseURLProblem(value), undefined)
})

test('拒绝非 http(s) 协议与无法解析的串', () => {
    for (const value of ['ftp://example.com/v1', 'example.com/v1', 'not-a-url', 'http://']) {
        assert.ok(baseURLProblem(value) !== undefined)
    }
})

test('空串视为未配置而非非法', () => {
    assert.equal(baseURLProblem(''), undefined)
})
