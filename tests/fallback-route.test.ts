import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { AUTO_PRESET } from '@deepseek-ai/dsh-permission-presets'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { applyFallback, getGuard } from '../src/fallback.ts'
import { FAILURE, SystemOneCallError } from '../src/systemone-client.ts'
import { setConfigInput } from '../src/config.ts'
import { FALLBACK_FAILURE_THRESHOLD, NOTICE_ROUTE } from '../src/shared/config.ts'

/** 审查配置段；测试可就地改写后复原。 */
let configValues: Record<string, unknown> = {
    baseURL: 'http://review.test',
    model: 'review-model',
    contextTokens: 24 * 1024,
    toolWhitelist: [],
    confidenceThreshold: 0.8,
    onSessionReset: 'workspace-write',
    onApiUnavailable: 'workspace-write',
    notifyOnFallback: true,
}

const configTest = (name: string, fn: () => unknown): void => {
    test(name, async () => {
        setConfigInput(() => configValues)
        try { await fn() } finally { setConfigInput(() => undefined) }
    })
}

interface RegisteredRoute {
    readonly methods: readonly string[]
    fetch: (request: Request) => Promise<Response>
}

/** connection.fetch 的最小桩：登记路由并支持注销。 */
function makeConnectionStub() {
    const routes = new Map<string, RegisteredRoute>()
    const connection = {
        fetch: {
            register: (route: { path: unknown; methods?: readonly string[]; fetch: (request: Request) => Promise<Response> }) => {
                const path = String(route.path)
                routes.set(path, { methods: route.methods ?? [], fetch: route.fetch })
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

/** 带连接与会话服务的最小宿主上下文；guard 降级只需空会话列表。 */
function makeCtx(): { ctx: Context; routes: Map<string, RegisteredRoute>; unregisterConnection: () => void } {
    const ctx = new Context()
    const { routes, connection } = makeConnectionStub()
    const unregisterConnection = ctx.provide('connection', connection)
    ctx.provide('sessions', { list: () => [] as unknown[] })
    return { ctx, routes, unregisterConnection: () => { unregisterConnection() } }
}

/** 把守卫推到阈值触发一次降级。 */
function degrade(): void {
    const counted = new SystemOneCallError(FAILURE.network, 'down')
    for (let index = 0; index < FALLBACK_FAILURE_THRESHOLD; index++) getGuard()!.failed(counted)
}

async function openStream(route: RegisteredRoute, signal?: AbortSignal): Promise<{ response: Response; reader: ReadableStreamDefaultReader<Uint8Array> }> {
    const response = await route.fetch(new Request('http://localhost/notice', { signal }))
    assert.equal(response.headers.get('content-type'), 'text/event-stream')
    return { response, reader: response.body!.getReader() }
}

async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
    const { value, done } = await reader.read()
    assert.ok(!done, '流在事件到达前已关闭')
    return new TextDecoder().decode(value)
}

/** 模拟重新选择 Auto 的会话事件，用于清零降级标记。 */
function reselectAuto(ctx: Context): void {
    ctx.emit('session/event', {} as Session, {
        type: 'permission/preset',
        data: { preset: AUTO_PRESET },
    } as unknown as SessionEvent)
}

configTest('没有连接服务的 profile 不注册路由但守卫仍然可用', async () => {
    const ctx = new Context()
    applyFallback(ctx)
    await flush()
    assert.ok(getGuard() !== undefined)
})

configTest('路由随连接注册为 GET，连接注销后路由解除', async () => {
    const { ctx, routes, unregisterConnection } = makeCtx()
    applyFallback(ctx)
    await flush()
    const route = routes.get(NOTICE_ROUTE)
    assert.ok(route !== undefined, '路由未注册')
    assert.deepEqual(route.methods, ['GET'])
    unregisterConnection()
    await flush()
    assert.ok(!routes.has(NOTICE_ROUTE), '连接注销后路由仍存在')
})

configTest('降级触发时向订阅流推送预设名事件', async () => {
    const { ctx, routes } = makeCtx()
    applyFallback(ctx)
    await flush()
    const { reader } = await openStream(routes.get(NOTICE_ROUTE)!)
    degrade()
    assert.equal(await readFrame(reader), 'data: {"preset":"workspace-write"}\n\n')
})

configTest('notifyOnFallback 为假时降级不推送', async () => {
    const { ctx, routes } = makeCtx()
    applyFallback(ctx)
    await flush()
    const { reader } = await openStream(routes.get(NOTICE_ROUTE)!)
    configValues.notifyOnFallback = false
    try {
        degrade()
        const outcome = await Promise.race([
            reader.read().then(() => 'pushed' as const),
            new Promise(resolve => setTimeout(() => resolve('silent' as const), 100)),
        ])
        assert.equal(outcome, 'silent')
    } finally {
        configValues.notifyOnFallback = true
    }
})

configTest('多个订阅者各自收到同一事件且互不影响', async () => {
    const { ctx, routes } = makeCtx()
    applyFallback(ctx)
    await flush()
    const route = routes.get(NOTICE_ROUTE)!
    const first = await openStream(route)
    const second = await openStream(route)
    degrade()
    const frame = 'data: {"preset":"workspace-write"}\n\n'
    assert.equal(await readFrame(first.reader), frame)
    assert.equal(await readFrame(second.reader), frame)
})

configTest('订阅中止后流关闭，后续通知不再投递且不残留监听', async () => {
    const { ctx, routes } = makeCtx()
    applyFallback(ctx)
    await flush()
    const route = routes.get(NOTICE_ROUTE)!
    const controller = new AbortController()
    const aborted = await openStream(route, controller.signal)
    degrade()
    assert.equal(await readFrame(aborted.reader), 'data: {"preset":"workspace-write"}\n\n')
    controller.abort()
    const tail = await aborted.reader.read()
    assert.ok(tail.done, '中止后流未关闭')
    // 清零降级标记后再次降级：老订阅者已注销，新订阅者照常收到。
    reselectAuto(ctx)
    const fresh = await openStream(route)
    degrade()
    assert.equal(await readFrame(fresh.reader), 'data: {"preset":"workspace-write"}\n\n')
})
