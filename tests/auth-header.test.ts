import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_CONFIG, parseAuthHeader } from '../src/shared/config.ts'
import { readReviewConfig } from '../src/config.ts'
import { postDecisionWithRetry } from '../src/systemone-client.ts'

/** 一次调用的基础入参；authHeader 逐用例覆盖。 */
const BASE = {
    baseURL: 'https://example.com/v1',
    fullURL: false,
    authHeader: '',
    model: 'm',
    apiKey: 'sk-test',
    signal: new AbortController().signal,
}

/** 一条合法响应。 */
const OK_BODY = {
    model: 'm',
    answers: {
        allow: { type: 'noul', noul: 0.93 },
    },
}

/** 记录一次调用的 init.headers。 */
const calls: RequestInit[] = []

/** 包装一个 fetch 实现并记录入参。 */
function spy(impl: () => Promise<Response>): typeof fetch {
    return (_url, init) => {
        calls.push(init as RequestInit)
        return impl()
    }
}

/** 发一次请求，返回实际发送的响应头。 */
async function sentHeaders(authHeader: string): Promise<Headers> {
    calls.length = 0
    await postDecisionWithRetry(
        { state: { cwd: '/p' }, questions: { allow: { type: 'noul', instructions: '是否允许' } } },
        { ...BASE, authHeader, fetchImpl: spy(() => Promise.resolve(new Response(JSON.stringify(OK_BODY), { status: 200 }))) },
    )
    return calls[0]?.headers as Headers
}

test('认证头三态解析', () => {
    assert.equal(parseAuthHeader(''), '')
    assert.equal(parseAuthHeader('x-api-key'), 'x-api-key')
    assert.equal(parseAuthHeader('!x-api-key'), '!x-api-key')
})

test('认证头归一化：全角与空白', () => {
    assert.equal(parseAuthHeader('  x-api-key  '), 'x-api-key')
    assert.equal(parseAuthHeader('！x-api-key'), '!x-api-key')
    assert.equal(parseAuthHeader('！ x-api-key '), '!x-api-key')
    assert.equal(parseAuthHeader('! x-api-key'), '!x-api-key')
    assert.equal(parseAuthHeader('\tx-api-key\n'), 'x-api-key')
})

test('非法头名拒绝：空头名与非 token 字符', () => {
    assert.equal(parseAuthHeader('!'), undefined)
    assert.equal(parseAuthHeader('！'), undefined)
    assert.equal(parseAuthHeader('bad name'), undefined)
    assert.equal(parseAuthHeader('x/api-key'), undefined)
    assert.equal(parseAuthHeader('头名'), undefined)
    assert.equal(parseAuthHeader('!x api'), undefined)
})

test('配置读取：缺省为空、存归一值、非法报错', () => {
    assert.equal(readReviewConfig({}).values.authHeader, DEFAULT_CONFIG.authHeader)
    assert.equal(readReviewConfig({ authHeader: '！ x-api-key' }).values.authHeader, '!x-api-key')
    assert.equal(readReviewConfig({ authHeader: '  ' }).values.authHeader, '')
    assert.throws(() => readReviewConfig({ authHeader: 'bad name' }), /authHeader/)
    assert.throws(() => readReviewConfig({ authHeader: '!' }), /authHeader/)
    assert.throws(() => readReviewConfig({ authHeader: 42 }), /authHeader/)
})

test('认证头为空时只发 Bearer', async () => {
    const headers = await sentHeaders('')
    assert.equal(headers.get('Authorization'), 'Bearer sk-test')
    assert.deepEqual([...headers.keys()], ['authorization', 'content-type'])
})

test('追加模式：Bearer 之外追加自定义头，值同凭据', async () => {
    const headers = await sentHeaders('x-api-key')
    assert.equal(headers.get('Authorization'), 'Bearer sk-test')
    assert.equal(headers.get('x-api-key'), 'sk-test')
})

test('替换模式：不发 Bearer，只发自定义头', async () => {
    const headers = await sentHeaders('!x-api-key')
    assert.equal(headers.get('Authorization'), null)
    assert.equal(headers.get('x-api-key'), 'sk-test')
    assert.deepEqual([...headers.keys()], ['content-type', 'x-api-key'])
})

test('头名已存在时无操作：!Authorization 保留预置的 Bearer', async () => {
    const headers = await sentHeaders('!Authorization')
    assert.equal(headers.get('Authorization'), 'Bearer sk-test')
})

test('追加模式同名头静默跳过：不覆盖已设的 Bearer', async () => {
    const headers = await sentHeaders('Authorization')
    assert.equal(headers.get('Authorization'), 'Bearer sk-test')
})

test('内置头不被覆盖：Content-Type 保持原值', async () => {
    const appended = await sentHeaders('Content-Type')
    assert.equal(appended.get('Authorization'), 'Bearer sk-test')
    assert.equal(appended.get('Content-Type'), 'application/json')
    const replaced = await sentHeaders('!Content-Type')
    assert.equal(replaced.get('Authorization'), 'Bearer sk-test')
    assert.equal(replaced.get('Content-Type'), 'application/json')
})

test('替换模式下头名已存在时不动请求头', async () => {
    const headers = await sentHeaders('!Content-Type')
    assert.deepEqual([...headers.keys()].sort(), ['authorization', 'content-type'])
    assert.equal(headers.get('Authorization'), 'Bearer sk-test')
    assert.equal(headers.get('Content-Type'), 'application/json')
})
