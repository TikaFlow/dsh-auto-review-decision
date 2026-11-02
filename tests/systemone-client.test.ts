import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
    postDecision,
    validateDecisionResponse,
    SystemOneCallError,
    FAILURE,
    type SystemOneFailureKind,
} from '../src/systemone-client.ts'

/** 两个问题的表：一个 noul、一个 score。 */
const QUESTIONS = {
    allow: { type: 'noul', instructions: '是否允许' },
    malice: { type: 'score', criteria: ['0', '1', '2', '3', '4'] },
} as const

/** 一次调用的基础入参。 */
const BASE = {
    baseURL: 'https://example.com/v1',
    fullURL: false,
    model: 'm',
    apiKey: 'sk-test',
    signal: new AbortController().signal,
}

/** 构造请求体；model 为空时不带该字段。 */
function request(model = 'm') {
    return { ...(model === '' ? {} : { model }), state: { cwd: '/p' }, questions: QUESTIONS }
}

/** 一条合法响应。 */
const OK_BODY = {
    model: 'm',
    answers: {
        allow: { type: 'noul', noul: 0.93 },
        malice: { type: 'score', score: 3.4, probabilities: { '0': 0.1, '1': 0.1, '2': 0.2, '3': 0.3, '4': 0.3 } },
    },
}

/** 记录每次调用的 fetch 包装。 */
interface Recorded {
    readonly url: string
    readonly init: RequestInit
}

/** 被调用的 URL 与 init 记录。 */
const calls: Recorded[] = []

/** 包装一个 fetch 实现并记录入参。 */
function spy(impl: () => Promise<Response>): typeof fetch {
    return (url, init) => {
        calls.push({ url: String(url), init: init as RequestInit })
        return impl()
    }
}

/** 断言拒绝结果的归类。 */
async function rejectsKind(
    run: () => Promise<unknown>,
    kind: SystemOneFailureKind,
    match?: string,
): Promise<void> {
    await assert.rejects(run, (error: unknown) => {
        if (!(error instanceof SystemOneCallError)) return false
        if (error.kind !== kind) return false
        return match === undefined || error.message.includes(match)
    })
}

test('端点、方法与请求头', async () => {
    calls.length = 0
    const result = await postDecision(request(), { ...BASE, fetchImpl: spy(() => Promise.resolve(new Response(JSON.stringify(OK_BODY), { status: 200 }))) })
    assert.ok(result.answers.allow?.type === 'noul')
    assert.equal(result.answers.allow.noul, 0.93)
    assert.equal(calls[0]?.url, 'https://example.com/v1/systemone')
    assert.equal(calls[0]?.init.method, 'POST')
    assert.equal((calls[0]?.init.headers as Record<string, string>)['Content-Type'], 'application/json')
    assert.equal((calls[0]?.init.headers as Record<string, string>).Authorization, 'Bearer sk-test')
    assert.deepEqual(Object.keys(JSON.parse(String(calls[0]?.init.body))), ['state', 'questions', 'model'])
})

test('基址尾部斜杠不产生重复斜杠', async () => {
    calls.length = 0
    await postDecision(request(), { ...BASE, baseURL: 'https://example.com/v1/', fetchImpl: spy(() => Promise.resolve(new Response(JSON.stringify(OK_BODY), { status: 200 }))) })
    assert.equal(calls[0]?.url, 'https://example.com/v1/systemone')
})

test('网关 result 信封解包', async () => {
    const result = await postDecision(request(), {
        ...BASE,
        fetchImpl: spy(() => Promise.resolve(new Response(JSON.stringify({ result: OK_BODY, success: true, errors: [], messages: [] }), { status: 200 }))),
    })
    assert.ok(result.answers.allow?.type === 'noul')
    assert.equal(result.answers.allow.noul, 0.93)
    assert.ok(result.answers.malice?.type === 'score')
    assert.equal(result.answers.malice.score, 3.4)
})

test('信封 result 非对象时按顶层体处理', async () => {
    await rejectsKind(
        () => postDecision(request(), {
            ...BASE,
            fetchImpl: spy(() => Promise.resolve(new Response(JSON.stringify({ result: null, success: false, errors: ['boom'], messages: [] }), { status: 200 }))),
        }),
        FAILURE.field,
        '响应缺少 answers',
    )
})

test('模型为空时不发送该字段', async () => {
    calls.length = 0
    await postDecision(request(''), { ...BASE, model: '', fetchImpl: spy(() => Promise.resolve(new Response(JSON.stringify(OK_BODY), { status: 200 }))) })
    assert.deepEqual(Object.keys(JSON.parse(String(calls[0]?.init.body))), ['state', 'questions'])
})

test('凭据缺失', async () => {
    await rejectsKind(() => postDecision(request(), { ...BASE, apiKey: '' }), FAILURE.config)
})

test('非 200 带摘要', async () => {
    await rejectsKind(
        () => postDecision(request(), {
            ...BASE,
            fetchImpl: spy(() => Promise.resolve(new Response('{"error":{"message":"boom","type":"x"}}', { status: 500 }))),
        }),
        FAILURE.status,
        'HTTP 500',
    )
    const error = await postDecision(request(), {
        ...BASE,
        fetchImpl: spy(() => Promise.resolve(new Response('{"error":{"message":"boom"}}', { status: 500 }))),
    }).catch((caught: unknown) => caught)
    assert.ok(error instanceof SystemOneCallError)
    assert.ok(error.message.includes('boom'))
})

test('非 200 无 JSON 时不带响应原文', async () => {
    const error = await postDecision(request(), {
        ...BASE,
        fetchImpl: spy(() => Promise.resolve(new Response('<html>gateway</html>', { status: 502 }))),
    }).catch((caught: unknown) => caught)
    assert.ok(error instanceof SystemOneCallError)
    assert.equal(error.kind, FAILURE.status)
    assert.ok(error.message.includes('HTTP 502'))
    assert.ok(!error.message.includes('gateway'))
})

test('响应不是 JSON', async () => {
    await rejectsKind(
        () => postDecision(request(), { ...BASE, fetchImpl: spy(() => Promise.resolve(new Response('not json', { status: 200 }))) }),
        FAILURE.parse,
    )
})

test('缺答案', async () => {
    await rejectsKind(
        () => postDecision(request(), {
            ...BASE,
            fetchImpl: spy(() => Promise.resolve(new Response(JSON.stringify({ answers: { allow: { type: 'noul', noul: 0.9 } } }), { status: 200 }))),
        }),
        FAILURE.field,
        'malice',
    )
})

test('答案类型不一致', async () => {
    await rejectsKind(
        () => postDecision(request(), {
            ...BASE,
            fetchImpl: spy(() => Promise.resolve(new Response(JSON.stringify({
                answers: { allow: { type: 'score', score: 1 }, malice: { type: 'score', score: 1 } },
            }), { status: 200 }))),
        }),
        FAILURE.field,
        '应为 noul',
    )
})

test('noul 越界不 clamp', async () => {
    await rejectsKind(
        () => postDecision(request(), {
            ...BASE,
            fetchImpl: spy(() => Promise.resolve(new Response(JSON.stringify({
                answers: { allow: { type: 'noul', noul: 1.5 }, malice: { type: 'score', score: 1 } },
            }), { status: 200 }))),
        }),
        FAILURE.range,
    )
})

test('score 越界不 clamp', async () => {
    await rejectsKind(
        () => postDecision(request(), {
            ...BASE,
            fetchImpl: spy(() => Promise.resolve(new Response(JSON.stringify({
                answers: { allow: { type: 'noul', noul: 0.9 }, malice: { type: 'score', score: 5 } },
            }), { status: 200 }))),
        }),
        FAILURE.range,
        '0–4',
    )
})

test('probabilities 含负数', async () => {
    await rejectsKind(
        () => postDecision(request(), {
            ...BASE,
            fetchImpl: spy(() => Promise.resolve(new Response(JSON.stringify({
                answers: { allow: { type: 'noul', noul: 0.9 }, malice: { type: 'score', score: 1, probabilities: { '0': -0.1 } } },
            }), { status: 200 }))),
        }),
        FAILURE.range,
    )
})

test('超时与外部中止分别归类', async () => {
    const timeout = (): Promise<Response> => {
        const error = new Error('The operation was aborted due to timeout')
        error.name = 'TimeoutError'
        return Promise.reject(error)
    }
    await rejectsKind(
        () => postDecision(request(), { ...BASE, signal: new AbortController().signal, fetchImpl: timeout }),
        FAILURE.timeout,
        '超时',
    )

    const controller = new AbortController()
    setTimeout(() => { controller.abort() }, 1)
    await rejectsKind(
        () => postDecision(request(), {
            ...BASE,
            signal: controller.signal,
            fetchImpl: () => new Promise((_resolve, reject) => {
                setTimeout(() => {
                    const error = new Error('aborted')
                    error.name = 'AbortError'
                    reject(error)
                }, 30)
            }),
        }),
        FAILURE.aborted,
    )
})

test('网络失败', async () => {
    await rejectsKind(
        () => postDecision(request(), { ...BASE, fetchImpl: () => Promise.reject(new TypeError('fetch failed')) }),
        FAILURE.network,
    )
})

test('错误信息不含密钥', async () => {
    const error = await postDecision(request(), {
        ...BASE,
        apiKey: 'sk-secret-abc',
        fetchImpl: spy(() => Promise.resolve(new Response('{"error":{"message":"boom"}}', { status: 500 }))),
    }).catch((caught: unknown) => caught)
    assert.ok(error instanceof SystemOneCallError)
    assert.ok(!error.message.includes('sk-secret-abc'))
})

test('响应校验可单独调用', () => {
    assert.throws(
        () => validateDecisionResponse(QUESTIONS, { model: 'm', answers: {} }),
        (error: unknown) => error instanceof SystemOneCallError && error.kind === FAILURE.field,
    )
})

test('每类失败的消息指明需修正的配置项', () => {
    const cases: ReadonlyArray<readonly [SystemOneFailureKind, string]> = [
        [FAILURE.config, 'API 密钥'],
        [FAILURE.timeout, 'API 地址'],
        [FAILURE.network, 'API 地址'],
        [FAILURE.status, 'API 地址'],
        [FAILURE.parse, 'API 地址'],
        [FAILURE.field, '模型 ID'],
        [FAILURE.range, '模型 ID'],
    ]
    for (const [kind, fix] of cases) {
        assert.ok(new SystemOneCallError(kind, 'x').message.includes(fix), `${kind} 应指向「${fix}」`)
    }
    assert.equal(new SystemOneCallError(FAILURE.aborted, 'x').message.includes('请检查'), false, '中止无需修正项')
})
