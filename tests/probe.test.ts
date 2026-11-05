/**
 * 双发测试第二发的失败归因：429、网络、其余各自落到不同失败码。
 *
 * 经宿主测试路由走完整双发流程，决策请求的 fetch 用桩替换后按脚本回放。
 *
 * @module tests/probe
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { installProbeRoute } from '../src/probe.ts'
import { TEST_ROUTE } from '../src/shared/config.ts'

/** 登记到 connection.fetch 的测试路由。 */
interface RegisteredRoute {
    fetch: (request: Request) => Promise<Response>
}

/** connection.fetch 的最小桩：登记路由并支持注销。 */
function makeConnectionStub(): {
    routes: Map<string, RegisteredRoute>
    connection: { fetch: { register: (route: { path: unknown; fetch: RegisteredRoute['fetch'] }) => () => Promise<void> } }
} {
    const routes = new Map<string, RegisteredRoute>()
    const connection = {
        fetch: {
            register: (route: { path: unknown; fetch: RegisteredRoute['fetch'] }) => {
                const path = String(route.path)
                routes.set(path, { fetch: route.fetch })
                return async () => { routes.delete(path) }
            },
        },
    }
    return { routes, connection }
}

/** 等待 cordis 的 inject/effect 调度落定。 */
async function flush(): Promise<void> {
    for (let round = 0; round < 3; round++) await new Promise(resolve => setImmediate(resolve))
}

/** 最小响应桩：只带决策调用读取的字段。 */
function stub(status: number, body: string): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: (): Promise<string> => Promise.resolve(body),
    } as unknown as Response
}

/** 一条合法的决策响应，带输入词元。 */
function ok(inputTokens: number): Response {
    return stub(200, JSON.stringify({
        answers: { balance: { type: 'noul', noul: 1 } },
        usage: { input_tokens: inputTokens },
    }))
}

/** 卡片草稿载荷：带上下文窗口即走双发。 */
const PAYLOAD = {
    baseURL: 'https://review.test',
    fullURL: false,
    authHeader: '',
    model: 'm',
    apiKey: 'sk-test',
    contextTokens: 8192,
}

/**
 * 按脚本回放两次决策请求，返回测试路由的响应体。
 * @param script - 依次对应 req1、req2 的响应；耗尽后回一条合法响应。
 */
async function doubleFire(script: Array<() => Response | Promise<Response>>): Promise<unknown> {
    const ctx = new Context()
    const { routes, connection } = makeConnectionStub()
    ctx.provide('connection', connection)
    installProbeRoute(ctx)
    await flush()
    const route = routes.get(TEST_ROUTE)
    assert.ok(route !== undefined, '测试路由未注册')

    const original = globalThis.fetch
    globalThis.fetch = ((_url: unknown, _init?: RequestInit): Promise<Response> => {
        const step = script.shift()
        return Promise.resolve(step === undefined ? ok(1) : step())
    }) as typeof fetch
    try {
        const response = await route.fetch(new Request(`http://localhost${TEST_ROUTE}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(PAYLOAD),
        }))
        return await response.json()
    } finally {
        globalThis.fetch = original
    }
}

test('双发第二发 429 归因为限流', async () => {
    const result = await doubleFire([() => ok(4000), () => stub(429, '{"error":{"message":"rate limited"}}')])
    assert.deepEqual(result, { ok: false, code: 'rateLimited' })
})

test('双发第二发网络失败归因为网络错误', async () => {
    const result = await doubleFire([() => ok(4000), () => Promise.reject(new TypeError('fetch failed'))])
    assert.deepEqual(result, { ok: false, code: 'networkFailed' })
})

test('双发第二发 HTTP 状态失败归为其余原因', async () => {
    const result = await doubleFire([() => ok(4000), () => stub(401, '{"error":{"message":"unauthorized"}}')])
    assert.deepEqual(result, { ok: false, code: 'unknownFailure' })
})
