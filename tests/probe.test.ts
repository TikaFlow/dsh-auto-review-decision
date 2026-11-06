/**
 * 连通性测试的回归用例：载荷校验、凭据回落、非法请求体、双发的 usage 缺失与首发限流、
 * 上下文窗口类型不符退回单发与越界拒绝，以及客户端等待窗口的常量约束。
 *
 * 经宿主测试路由走完整流程，决策请求的 fetch 用桩替换后按脚本回放。
 *
 * @module tests/probe
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { budgetState, historyBytes, observe } from '../src/budget.ts'
import { installProbeRoute } from '../src/probe.ts'
import { CLIENT_TIMEOUT_MS, MAX_CONTEXT_TOKENS, MIN_CONTEXT_TOKENS, PROBE_TIMEOUT_MS, TEST_ROUTE } from '../src/shared/config.ts'

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

/** 一条合法的决策响应，但不回报 usage。 */
function okWithoutUsage(): Response {
    return stub(200, JSON.stringify({ answers: { balance: { type: 'noul', noul: 1 } } }))
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

/** 一次测试路由调用的可选项。 */
interface FireOptions {
    /** 替代默认草稿的载荷；用于逐项覆盖字段。 */
    readonly payload?: unknown
    /** 原样发送的请求体，用于非法 JSON；优先于 `payload`。 */
    readonly rawBody?: string
    /** 凭据桩的返回值；缺省表示未配置。 */
    readonly credential?: string
}

/** 一次测试路由调用观测到的结果与决策请求入参。 */
interface FireResult {
    readonly result: unknown
    readonly calls: RequestInit[]
}

/**
 * 按脚本回放决策请求，返回测试路由的响应体与每次决策调用的入参。
 * @param script - 依次回放；耗尽后回一条合法响应。
 * @param options - 载荷、请求体与凭据桩。
 */
async function fire(script: Array<() => Response | Promise<Response>>, options: FireOptions = {}): Promise<FireResult> {
    const ctx = new Context()
    const { routes, connection } = makeConnectionStub()
    ctx.provide('connection', connection)
    ctx.provide('credentials', {
        resolve: async () => options.credential === undefined ? undefined : { value: options.credential },
    })
    installProbeRoute(ctx)
    await flush()
    const route = routes.get(TEST_ROUTE)
    assert.ok(route !== undefined, '测试路由未注册')

    const calls: RequestInit[] = []
    const original = globalThis.fetch
    globalThis.fetch = ((_url: unknown, init?: RequestInit): Promise<Response> => {
        calls.push(init as RequestInit)
        const step = script.shift()
        return Promise.resolve(step === undefined ? ok(1) : step())
    }) as typeof fetch
    try {
        const response = await route.fetch(new Request(`http://localhost${TEST_ROUTE}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: options.rawBody ?? JSON.stringify(options.payload ?? PAYLOAD),
        }))
        return { result: await response.json(), calls }
    } finally {
        globalThis.fetch = original
    }
}

/** 只取响应体，保持既有用例的调用形态。 */
async function doubleFire(script: Array<() => Response | Promise<Response>>): Promise<unknown> {
    return (await fire(script)).result
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

test('载荷非对象或空对象归为基址无效', async () => {
    for (const payload of [42, 'text', {}]) {
        const { result, calls } = await fire([], { payload })
        assert.deepEqual(result, { ok: false, code: 'baseURLInvalid' })
        assert.equal(calls.length, 0, '校验未通过不应发出决策请求')
    }
})

test('非法基址归为基址无效', async () => {
    for (const baseURL of ['ftp://review.test', 'not-a-url', '']) {
        const { result, calls } = await fire([], { payload: { ...PAYLOAD, baseURL } })
        assert.deepEqual(result, { ok: false, code: 'baseURLInvalid' })
        assert.equal(calls.length, 0, '校验未通过不应发出决策请求')
    }
})

test('缺 key 且凭据未配置时仍发请求，以 public 占位', async () => {
    const { result, calls } = await fire([], { payload: { ...PAYLOAD, apiKey: '', contextTokens: undefined } })
    assert.ok(isPassed(result))
    assert.equal(calls.length, 1, '无凭据也应发出决策请求')
    assert.equal((calls[0]?.headers as Headers).get('Authorization'), 'Bearer public')
})

test('缺 key 时改用已保存凭据发请求', async () => {
    const payload = {
        baseURL: 'https://review.test',
        fullURL: false,
        authHeader: '',
        model: 'm',
        apiKey: '',
    }
    const { result, calls } = await fire([], { payload, credential: 'sk-saved' })
    assert.ok(isPassed(result))
    assert.equal((result as { inputTokens?: number }).inputTokens, 1)
    assert.equal(calls.length, 1)
    assert.equal((calls[0]?.headers as Headers).get('Authorization'), 'Bearer sk-saved')
})

test('认证头非法归为认证头无效', async () => {
    const { result, calls } = await fire([], { payload: { ...PAYLOAD, authHeader: 'bad name' } })
    assert.deepEqual(result, { ok: false, code: 'authHeaderInvalid' })
    assert.equal(calls.length, 0, '认证头非法不应发出决策请求')
})

test('请求体不是合法 JSON 归为响应非法', async () => {
    const { result, calls } = await fire([], { rawBody: '{not json' })
    assert.deepEqual(result, { ok: false, code: 'invalidResponse' })
    assert.equal(calls.length, 0, '请求体解析失败不应发出决策请求')
})

test('双发首发成功但不回 usage 时只发一次并视为通过', async () => {
    const { result, calls } = await fire([() => okWithoutUsage()])
    assert.deepEqual(result, { ok: true })
    assert.equal(calls.length, 1, '没有 usage 不应发出第二发')
})

test('双发首发限流不重试，回传诊断原文', async () => {
    const { result, calls } = await fire([() => stub(429, '{"error":{"message":"rate limited"}}')])
    assert.ok(isFailed(result))
    assert.ok(result.message?.includes('HTTP 429'))
    assert.equal(calls.length, 1, '探活不重试，限流也只发一次')
})

test('contextTokens 非数字时退回单发', async () => {
    // NaN 无法通过 JSON 承载，序列化后成为 null，与缺失等价，仍应走单发。
    for (const contextTokens of ['8192', null, Number.NaN]) {
        const { result, calls } = await fire([], { payload: { ...PAYLOAD, contextTokens } })
        assert.ok(isPassed(result))
        assert.equal(calls.length, 1, '非数字上下文窗口不应进入双发')
    }
})

test('contextTokens 越界按载荷非法拒绝', async () => {
    for (const contextTokens of [MIN_CONTEXT_TOKENS - 1, 0, -1, MAX_CONTEXT_TOKENS + 1]) {
        const { result, calls } = await fire([], { payload: { ...PAYLOAD, contextTokens } })
        assert.deepEqual(result, { ok: false, code: 'invalidResponse' })
        assert.equal(calls.length, 0, '越界上下文窗口不应发出决策请求')
    }
})

test('contextTokens 取边界值时进入双发', async () => {
    for (const contextTokens of [MIN_CONTEXT_TOKENS, MAX_CONTEXT_TOKENS]) {
        // 首发回报与填充体积相称的词元数，避免因子被抬到极端后把第二发撑爆。
        const inputTokens = Math.floor(contextTokens * 0.95)
        const { result, calls } = await fire([() => ok(inputTokens), () => ok(1)], { payload: { ...PAYLOAD, contextTokens } })
        assert.ok(isPassed(result))
        assert.equal(calls.length, 2, '边界值应走双发')
    }
})

test('超大 contextTokens 不抛异常，回可读错误', async () => {
    const contextTokens = Number.MAX_SAFE_INTEGER
    const { result, calls } = await fire([], { payload: { ...PAYLOAD, contextTokens } })
    assert.deepEqual(result, { ok: false, code: 'invalidResponse' })
    assert.equal(calls.length, 0, '超大上下文窗口不应发出决策请求')
})

test('客户端等待窗口等于探活两次尝试的 15 秒', () => {
    assert.equal(CLIENT_TIMEOUT_MS, PROBE_TIMEOUT_MS * 2)
})

/** 账本观测签名：沿用载荷中的端点与模型组合，与其他用例的签名互不相同。 */
const PROBE_SIGNATURE = `${PAYLOAD.baseURL}|${String(PAYLOAD.fullURL)}|${PAYLOAD.model}`

/** 把账本校准到 4 字节/token，作为探活前后的对照。 */
function seedBudget(): void {
    observe(PROBE_SIGNATURE, 4000, 1000)
}

test('双发成功全程不改动同签名的账本，也不影响随后的审查取值', async () => {
    seedBudget()
    const before = budgetState()
    const historyBefore = historyBytes(PROBE_SIGNATURE, PAYLOAD.contextTokens, 1000)

    // 两次决策请求发出时各取一次账本快照，确认探活中途也未重置或回灌。
    const snapshots: Array<ReturnType<typeof budgetState>> = []
    const { result, calls } = await fire([
        () => {
            snapshots.push(budgetState())
            return ok(4000)
        },
        () => {
            snapshots.push(budgetState())
            return ok(1)
        },
    ])

    assert.ok(isPassed(result))
    assert.equal(calls.length, 2)
    assert.deepEqual(snapshots, [before, before])
    assert.deepEqual(budgetState(), before)
    assert.equal(historyBytes(PROBE_SIGNATURE, PAYLOAD.contextTokens, 1000), historyBefore)
})

test('双发首发不回 usage 时账本保持原样', async () => {
    seedBudget()
    const before = budgetState()
    const { result, calls } = await fire([() => okWithoutUsage()])
    assert.deepEqual(result, { ok: true })
    assert.equal(calls.length, 1)
    assert.deepEqual(budgetState(), before)
})

test('双发首发失败时账本保持原样', async () => {
    seedBudget()
    const before = budgetState()
    const { result, calls } = await fire([() => stub(429, '{"error":{"message":"rate limited"}}')])
    assert.ok(isFailed(result))
    assert.equal(calls.length, 1)
    assert.deepEqual(budgetState(), before)
})

/** 失败结果的最小形状。 */
function isFailed(value: unknown): value is { readonly ok: false; readonly message?: string } {
    return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false
}

/** 通过结果的最小形状。 */
function isPassed(value: unknown): value is { readonly ok: true } {
    return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === true
}
