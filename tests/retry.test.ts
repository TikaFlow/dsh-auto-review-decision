/**
 * HTTP 429 退避重试的用例：指数退避序列、耗尽失败、非 429 立即返回、重试次数参数、等待可被中止。
 * 退避间隔由实现固定（1s 起倍增），涉及时序的用例用 node:test 的 mock 时钟推进；
 * 响应用最小桩代替真实 Response，避免 undici 内部时序受 mock 时钟影响。
 *
 * @module tests/retry
 */

import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import {
    FAILURE,
    SystemOneCallError,
    postDecisionWithRetry,
    type SystemOneFailureKind,
} from '../src/systemone-client.ts'

/** 一个问题的表：noul。 */
const QUESTIONS = {
    balance: { type: 'noul', instructions: '是否允许' },
} as const

/** 一次调用的基础入参；signal 由各用例自备。 */
const BASE = {
    baseURL: 'https://example.com/v1',
    fullURL: false,
    authHeader: '',
    model: 'm',
    apiKey: 'sk-test',
}

/** 一条合法响应体。 */
const OK_BODY = JSON.stringify({ model: 'm', answers: { balance: { type: 'noul', noul: 0.9 } } })

/** 构造请求体。 */
function request(): { state: { cwd: string }; questions: typeof QUESTIONS } {
    return { state: { cwd: '/p' }, questions: QUESTIONS }
}

/** 最小响应桩：只带重试路径读取的字段。 */
function stub(status: number, body: string): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: (): Promise<string> => Promise.resolve(body),
    } as unknown as Response
}

/** 一条 429 响应。 */
function throttled(): Response {
    return stub(429, '{"error":{"message":"rate limited"}}')
}

/** 一条合法响应。 */
function ok(): Response {
    return stub(200, OK_BODY)
}

/** 按脚本依次回放响应的 fetch 包装，并记录每次调用的时刻。 */
function scripted(script: Array<() => Response>): { fetchImpl: typeof fetch; times: number[] } {
    const times: number[] = []
    const fetchImpl = ((_url: unknown, _init?: unknown): Promise<Response> => {
        times.push(performance.now())
        const step = script.shift()
        return Promise.resolve(step !== undefined ? step() : ok())
    }) as typeof fetch
    return { fetchImpl, times }
}

/** 断言拒绝结果的归类，并返回捕获到的错误。 */
async function rejectsKind(
    run: () => Promise<unknown>,
    kind: SystemOneFailureKind,
    match?: string,
): Promise<SystemOneCallError> {
    let captured: SystemOneCallError | undefined
    await assert.rejects(run, (error: unknown) => {
        if (!(error instanceof SystemOneCallError)) return false
        if (error.kind !== kind) return false
        const matched = match === undefined || error.message.includes(match)
        if (matched) captured = error
        return matched
    })
    return captured as SystemOneCallError
}

/** 用 setImmediate 排空微任务，让响应链与重试循环推进到位。 */
async function settle(): Promise<void> {
    await new Promise((resolve) => { setImmediate(resolve) })
}

test('429 按指数退避（1/2/4/8/16 秒）重试共 5 次后仍 429 则失败', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const { fetchImpl, times } = scripted([throttled, throttled, throttled, throttled, throttled, throttled])
        const captured = postDecisionWithRetry(request(), { ...BASE, signal: new AbortController().signal, fetchImpl })
            .catch((error: unknown) => error)
        await settle()
        for (const [i, delay] of [1000, 2000, 4000, 8000, 16000].entries()) {
            mock.timers.tick(delay - 1)
            await settle()
            assert.equal(times.length, i + 1, `等待未满 ${String(delay)}ms 不应发起第 ${String(i + 2)} 次请求`)
            mock.timers.tick(1)
            await settle()
            assert.equal(times.length, i + 2, `等待满 ${String(delay)}ms 后应发起第 ${String(i + 2)} 次请求`)
        }
        const error = await captured
        assert.ok(error instanceof SystemOneCallError)
        assert.equal(error.kind, FAILURE.status)
        assert.ok(error.message.includes('HTTP 429'))
        assert.equal(times.length, 6)
    } finally {
        mock.timers.reset()
    }
})

test('429 退避重试成功即止', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const { fetchImpl, times } = scripted([throttled, throttled])
        const run = postDecisionWithRetry(request(), { ...BASE, signal: new AbortController().signal, fetchImpl })
        await settle()
        mock.timers.tick(1000)
        await settle()
        mock.timers.tick(2000)
        await settle()
        const result = await run
        assert.ok(result.answers.balance?.type === 'noul')
        assert.equal(times.length, 3)
    } finally {
        mock.timers.reset()
    }
})

test('重试过程中遇到非 429 立即返回，不再继续重试', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const { fetchImpl, times } = scripted([throttled, throttled, () => stub(500, '{"error":{"message":"boom"}}')])
        // 先挂上捕获器再推进时钟，避免拒绝在断言前落为 unhandled rejection。
        const captured = postDecisionWithRetry(request(), { ...BASE, signal: new AbortController().signal, fetchImpl })
            .catch((error: unknown) => error)
        await settle()
        mock.timers.tick(1000)
        await settle()
        mock.timers.tick(2000)
        await settle()
        const error = await captured
        assert.ok(error instanceof SystemOneCallError)
        assert.equal(error.kind, FAILURE.status)
        assert.ok(error.message.includes('HTTP 500'))
        assert.ok(error.message.includes('boom'))
        assert.equal(times.length, 3)
    } finally {
        mock.timers.reset()
    }
})

test('重试次数为 0 时 429 也不重试，只发一次请求', async () => {
    const { fetchImpl, times } = scripted([throttled, ok])
    await rejectsKind(
        () => postDecisionWithRetry(request(), { ...BASE, signal: new AbortController().signal, fetchImpl }, 0),
        FAILURE.status,
        'HTTP 429',
    )
    assert.equal(times.length, 1)
})

test('重试耗尽次数由参数决定：retries 2 时共 3 次请求', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const { fetchImpl, times } = scripted([throttled, throttled, throttled])
        const captured = postDecisionWithRetry(request(), { ...BASE, signal: new AbortController().signal, fetchImpl }, 2)
            .catch((error: unknown) => error)
        await settle()
        mock.timers.tick(1000)
        await settle()
        mock.timers.tick(2000)
        await settle()
        const error = await captured
        assert.ok(error instanceof SystemOneCallError)
        assert.equal(error.kind, FAILURE.status)
        assert.ok(error.message.includes('HTTP 429'))
        assert.equal(times.length, 3)
    } finally {
        mock.timers.reset()
    }
})

test('429 以外的 HTTP 状态不重试', async () => {
    const { fetchImpl, times } = scripted([() => stub(500, '{"error":{"message":"boom"}}')])
    await rejectsKind(
        () => postDecisionWithRetry(request(), { ...BASE, signal: new AbortController().signal, fetchImpl }),
        FAILURE.status,
        'HTTP 500',
    )
    assert.equal(times.length, 1)
})

test('网络错误不重试', async () => {
    let calls = 0
    await rejectsKind(
        () => postDecisionWithRetry(request(), {
            ...BASE,
            signal: new AbortController().signal,
            fetchImpl: () => {
                calls++
                return Promise.reject(new TypeError('fetch failed'))
            },
        }),
        FAILURE.network,
    )
    assert.equal(calls, 1)
})

test('退避等待可被调用方中止，立即失败不吞掉', async () => {
    const controller = new AbortController()
    const { fetchImpl, times } = scripted([throttled])
    setTimeout(() => { controller.abort() }, 30)
    const error = await rejectsKind(
        () => postDecisionWithRetry(request(), { ...BASE, signal: controller.signal, fetchImpl }),
        FAILURE.aborted,
    )
    assert.ok(error.message.includes('中止'))
    assert.equal(times.length, 1)
})

test('调用方为超时信号时，等待被打断按超时归类', async () => {
    const { fetchImpl, times } = scripted([throttled])
    const error = await rejectsKind(
        () => postDecisionWithRetry(request(), { ...BASE, signal: AbortSignal.timeout(40), fetchImpl }),
        FAILURE.timeout,
    )
    assert.ok(error.message.includes('超时'))
    assert.equal(times.length, 1)
})
