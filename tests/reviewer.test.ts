import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { ToolCallId, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { FALLBACK_FAILURE_THRESHOLD } from '../src/shared/config.ts'
import { CREDENTIAL_REF } from '../src/shared/config.ts'
import { setConfigInput } from '../src/config.ts'
import { classifyRisk } from '../src/reviewer.ts'
import { FallbackGuard } from '../src/fallback.ts'
import { FAILURE, SystemOneCallError } from '../src/systemone-client.ts'
import { decisionQuestions } from '../src/questions.ts'
import type { ReviewVerdict } from '../src/questions.ts'
import { SCORE_QUESTION_IDS } from '../src/shared/questions.ts'
import type { SystemOneResponse } from '../src/systemone.ts'

/** 从源文件原样提取 REVIEW_POLICY，避免复制旧文本。 */
const REVIEW_POLICY = (() => {
    const source = readFileSync(new URL('../src/reviewer.ts', import.meta.url), 'utf8')
    const match = /const REVIEW_POLICY = `([^`]+)`/u.exec(source)
    assert.ok(match !== null, 'REVIEW_POLICY 未在源文件中找到')
    return match[1]
})()

const API_KEY = 'test-secret-key'
const ENDPOINT = 'http://review.test/systemone'

/** 审查所需的配置段；测试可就地改写后复原。 */
let configValues: Record<string, unknown> = {
    baseURL: 'http://review.test',
    fullURL: false,
    model: 'review-model',
    contextTokens: 24 * 1024,
    toolWhitelist: [],
    confidenceThreshold: 0.8,
    onSessionReset: 'workspace-write',
    onApiUnavailable: 'workspace-write',
    notifyOnFallback: true,
}
setConfigInput(() => configValues)

test.after(() => { setConfigInput(() => undefined) })

/** reviewer 只消费 credentials.resolve 与 workingDirectory.ensure，stub 仅含这两者。 */
function makeCtx(credential: ResolvedCredential | undefined): Context {
    return {
        credentials: { resolve: async () => credential },
        workingDirectory: { ensure: async () => '/workspace' },
    } as unknown as Context
}

function makeAgent(session: Session): Agent {
    return { session } as unknown as Agent
}

const PROBE_SCHEMA: ToolSchema = {
    name: 'probe',
    description: 'live probe description',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}

/** 组装最小可审会话：请求头、用户指令、当前步骤里的说明与原生调用。 */
function makeReviewSession(argumentsText = '{"path":"a.txt"}'): { session: Session; exec: ToolExecution } {
    const session = Session.create(SessionId('s-review'))
    session.append('request/header', {
        header: { config: { provider: 'review', model: 'review-model' }, tools: [PROBE_SCHEMA] },
        reason: 'initial',
    })
    session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: '清理本次会话生成的临时文件' }],
        source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
        turn: 1,
        step: 1,
        stream: [],
        message: createMessage({
            role: 'assistant',
            content: [
                { type: 'text', text: '我来删除临时文件' },
                { type: 'tool-call', id: ToolCallId('call-1'), name: 'probe', arguments: argumentsText },
            ],
            source: { kind: 'model', provider: 'review', model: 'review-model' },
        }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', {
        turn: 1,
        step: 1,
        callId: ToolCallId('call-1'),
        name: 'probe',
        arguments: argumentsText,
    })
    const exec = {
        callId: ToolCallId('call-1'),
        rootCallId: ToolCallId('call-1'),
        name: 'probe',
        arguments: JSON.parse(argumentsText) as unknown,
        signal: new AbortController().signal,
    } as ToolExecution
    return { session, exec }
}

interface CapturedCall {
    readonly url: string
    readonly init: RequestInit
}

/** 记录请求并按脚本回放响应。 */
function capturingFetch(respond: (call: CapturedCall) => Response): { calls: CapturedCall[]; fetch: typeof fetch } {
    const calls: CapturedCall[] = []
    const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const call: CapturedCall = { url: String(input), init: init ?? {} }
        calls.push(call)
        return respond(call)
    }
    return { calls, fetch: impl as typeof fetch }
}

/** 全部档位给满安全侧概率的答案表；可指定单个问题的概率覆盖。 */
function answersWith(
    noul: number,
    failing?: { readonly id: string; readonly probabilities: Readonly<Record<string, number>> },
): SystemOneResponse {
    const answers: Record<string, SystemOneResponse['answers'][string]> = {
        allow: { type: 'noul', noul },
    }
    for (const id of SCORE_QUESTION_IDS) {
        const probabilities = failing !== undefined && failing.id === id
            ? { ...failing.probabilities }
            : { '4': 1 }
        answers[id] = { type: 'score', score: 4, probabilities }
    }
    return { model: 'review-model', answers }
}

function okResponse(payload: SystemOneResponse): Response {
    return new Response(JSON.stringify({ result: payload }), { status: 200 })
}

async function reviewOnce(
    session: Session,
    exec: ToolExecution,
    respond: (call: CapturedCall) => Response,
): Promise<{ verdict: ReviewVerdict; calls: CapturedCall[] }> {
    const { calls, fetch } = capturingFetch(respond)
    const verdict = await classifyRisk(makeCtx({ value: API_KEY, source: 'test' }), makeAgent(session), exec, exec.signal, new Map(), { fetchImpl: fetch })
    return { verdict, calls }
}

test('请求体携带环境、策略原文、问题表与待审调用，密钥只出现在 Authorization 头', async () => {
    const { session, exec } = makeReviewSession()
    const { verdict, calls } = await reviewOnce(session, exec, () => okResponse(answersWith(1)))
    assert.equal(verdict.kind, 'allow')
    assert.equal(calls.length, 1)
    const { url, init } = calls[0]!
    assert.equal(url, ENDPOINT)
    assert.equal(init.method, 'POST')
    assert.equal(init.headers && (init.headers as Record<string, string>)['Authorization'], `Bearer ${API_KEY}`)
    const body = JSON.parse(String(init.body)) as {
        model?: string
        state: { environment: { cwd: string }; policy: string; history: unknown[]; pending: { name: string; arguments: unknown } }
        questions: unknown
    }
    assert.equal(body.model, 'review-model')
    assert.deepEqual(body.state.environment, { cwd: '/workspace' })
    assert.equal(body.state.policy, REVIEW_POLICY)
    assert.deepEqual(body.state.pending, { name: 'probe', arguments: { path: 'a.txt' } })
    assert.deepEqual(body.questions, decisionQuestions())
    assert.ok(!String(init.body).includes(API_KEY))
})

test('history 依次携带用户指令、模型说明、工具 schema 与历史调用', async () => {
    const { session, exec } = makeReviewSession()
    const { calls } = await reviewOnce(session, exec, () => okResponse(answersWith(1)))
    const body = JSON.parse(String(calls[0]!.init.body)) as {
        state: { history: Array<{ kind: string; role?: string; name?: string; text?: string; arguments?: unknown }> }
    }
    const history = body.state.history
    assert.deepEqual(history.map(entry => [entry.kind, entry.role]), [
        ['user-message', 'user-instruction'],
        ['assistant-claim', 'fact'],
        ['tool-schema', 'fact'],
        ['tool-call', 'fact'],
    ])
    assert.equal(history[0]!.name, undefined)
    assert.equal(history[2]!.name, 'probe')
    assert.equal(history[3]!.arguments, '{"path":"a.txt"}')
    assert.equal(history[1]!.text, '我来删除临时文件')
})

test('待审调用的 schema 已登记到 shown，供后续审查复用', async () => {
    const { session, exec } = makeReviewSession()
    const shown = new Map()
    const { calls, fetch } = capturingFetch(() => okResponse(answersWith(1)))
    await classifyRisk(makeCtx({ value: API_KEY, source: 'test' }), makeAgent(session), exec, exec.signal, shown, { fetchImpl: fetch })
    assert.equal(shown.size, 1)
    const [key, schema] = [...shown.entries()][0]!
    assert.ok(key.startsWith('native\0'))
    assert.equal(schema.name, 'probe')
    assert.ok(calls.length === 1)
})

test('全部问题通过判定线时结论为 allow', async () => {
    const { session, exec } = makeReviewSession()
    const { verdict } = await reviewOnce(session, exec, () => okResponse(answersWith(1)))
    assert.deepEqual(verdict, { kind: 'allow' })
})

test('总判定问题低于拒绝线时直接 deny', async () => {
    const { session, exec } = makeReviewSession()
    const { verdict } = await reviewOnce(session, exec, () => okResponse(answersWith(0.1)))
    assert.deepEqual(verdict, { kind: 'deny', reason: '该调用未通过安全审查' })
})

test('总分不足且高于拒绝线时落为 ask 并携带问题标签', async () => {
    const { session, exec } = makeReviewSession()
    // noul 足够高进入补偿通道，但 malice 的安全侧全押在「不确定」档：不满足放行、高于拒绝线。
    const { verdict } = await reviewOnce(session, exec, () => okResponse(answersWith(0.9, { id: 'malice', probabilities: { '2': 1 } })))
    assert.deepEqual(verdict, { kind: 'ask', reason: '存在恶意意图，是否执行？' })
})

test('参数明显违反契约时直接放行，不发出决策请求', async () => {
    const { session, exec } = makeReviewSession('{"path":123}')
    const { calls, fetch } = capturingFetch(() => { throw new Error('must not be called') })
    const verdict = await classifyRisk(makeCtx({ value: API_KEY, source: 'test' }), makeAgent(session), exec, exec.signal, new Map(), { fetchImpl: fetch })
    assert.deepEqual(verdict, { kind: 'allow' })
    assert.equal(calls.length, 0)
})

test('用户白名单命中的工具免审且不发出决策请求', async () => {
    const { session, exec } = makeReviewSession()
    configValues.toolWhitelist = ['probe']
    try {
        const { calls, fetch } = capturingFetch(() => { throw new Error('must not be called') })
        const verdict = await classifyRisk(makeCtx({ value: API_KEY, source: 'test' }), makeAgent(session), exec, exec.signal, new Map(), { fetchImpl: fetch })
        assert.deepEqual(verdict, { kind: 'allow' })
        assert.equal(calls.length, 0)
    } finally {
        configValues.toolWhitelist = []
    }
})

test('HTTP 非 200 归类为 status 失败并携带响应摘要', async () => {
    const { session, exec } = makeReviewSession()
    await assert.rejects(
        reviewOnce(session, exec, () => new Response(JSON.stringify({ error: 'server exploded' }), { status: 500 })),
        (error: unknown) => {
            assert.ok(error instanceof SystemOneCallError)
            assert.equal(error.kind, FAILURE.status)
            assert.ok(error.message.includes('HTTP 500'))
            assert.ok(error.message.includes('server exploded'))
            assert.ok(!error.message.includes(API_KEY))
            return true
        },
    )
})

test('200 但响应非协议结构时归类为 field 失败', async () => {
    const { session, exec } = makeReviewSession()
    await assert.rejects(
        reviewOnce(session, exec, () => new Response(JSON.stringify({ result: { model: 'x' } }), { status: 200 })),
        (error: unknown) => {
            assert.ok(error instanceof SystemOneCallError)
            assert.equal(error.kind, FAILURE.field)
            return true
        },
    )
})

test('200 但响应不是 JSON 时归类为 parse 失败', async () => {
    const { session, exec } = makeReviewSession()
    await assert.rejects(
        reviewOnce(session, exec, () => new Response('<html>gateway</html>', { status: 200 })),
        (error: unknown) => {
            assert.ok(error instanceof SystemOneCallError)
            assert.equal(error.kind, FAILURE.parse)
            return true
        },
    )
})

test('网络失败归类为 network，错误信息不含密钥', async () => {
    const { session, exec } = makeReviewSession()
    const { fetch } = capturingFetch(() => { throw new Error('connection refused') })
    await assert.rejects(
        classifyRisk(makeCtx({ value: API_KEY, source: 'test' }), makeAgent(session), exec, exec.signal, new Map(), { fetchImpl: fetch }),
        (error: unknown) => {
            assert.ok(error instanceof SystemOneCallError)
            assert.equal(error.kind, FAILURE.network)
            assert.ok(error.message.includes('connection refused'))
            assert.ok(!error.message.includes(API_KEY))
            return true
        },
    )
})

test('凭据未配置时归类为 config 失败且不发请求', async () => {
    const { session, exec } = makeReviewSession()
    const { calls, fetch } = capturingFetch(() => { throw new Error('must not be called') })
    await assert.rejects(
        classifyRisk(makeCtx(undefined), makeAgent(session), exec, exec.signal, new Map(), { fetchImpl: fetch }),
        (error: unknown) => {
            assert.ok(error instanceof SystemOneCallError)
            assert.equal(error.kind, FAILURE.config)
            assert.ok(error.message.includes('凭据未配置'))
            return true
        },
    )
    assert.equal(calls.length, 0)
})

test('必填配置缺失时归类为 config 失败', async () => {
    const { session, exec } = makeReviewSession()
    const saved = configValues
    configValues = {}
    try {
        await assert.rejects(
            reviewOnce(session, exec, () => okResponse(answersWith(1))),
            (error: unknown) => {
                assert.ok(error instanceof SystemOneCallError)
                assert.equal(error.kind, FAILURE.config)
                assert.ok(error.message.includes('配置未完成'))
                return true
            },
        )
    } finally {
        configValues = saved
    }
})

test('计入降级的失败连续累计，达阈值降级一次且不重复发布', () => {
    const published: string[] = []
    const guard = new FallbackGuard({ sessions: { list: () => [] } } as unknown as Context, () => 'workspace-write', () => true, (preset) => { published.push(preset) })
    const counted = new SystemOneCallError(FAILURE.network, 'down')
    for (let index = 1; index < FALLBACK_FAILURE_THRESHOLD; index++) guard.failed(counted)
    assert.deepEqual(published, [])
    guard.failed(counted)
    assert.deepEqual(published, ['workspace-write'])
    guard.failed(counted)
    assert.deepEqual(published, ['workspace-write'])
})

test('中止类失败与非协议错误不计入降级计数', () => {
    const published: string[] = []
    const guard = new FallbackGuard({ sessions: { list: () => [] } } as unknown as Context, () => 'workspace-write', () => false, (preset) => { published.push(preset) })
    const aborted = new SystemOneCallError(FAILURE.aborted, 'stopped')
    for (let index = 0; index < FALLBACK_FAILURE_THRESHOLD; index++) guard.failed(aborted)
    assert.deepEqual(published, [])
    for (let index = 0; index < FALLBACK_FAILURE_THRESHOLD; index++) guard.failed(new Error('plain crash'))
    assert.deepEqual(published, [])
})

test('成功清零计数：失败后成功再失败不累计降级', () => {
    const published: string[] = []
    const guard = new FallbackGuard({ sessions: { list: () => [] } } as unknown as Context, () => 'workspace-write', () => true, (preset) => { published.push(preset) })
    const counted = new SystemOneCallError(FAILURE.network, 'down')
    for (let index = 1; index < FALLBACK_FAILURE_THRESHOLD; index++) guard.failed(counted)
    guard.succeeded()
    for (let index = 1; index < FALLBACK_FAILURE_THRESHOLD; index++) guard.failed(counted)
    assert.deepEqual(published, [])
})

test('降级去向为 system 时实时读取宿主默认预设', () => {
    const published: string[] = []
    const guard = new FallbackGuard({
        sessions: { list: () => [] },
        permissionPresets: { defaultPreset: 'read-only' },
    } as unknown as Context, () => 'system', () => true, (preset) => { published.push(preset) })
    const counted = new SystemOneCallError(FAILURE.network, 'down')
    for (let index = 0; index < FALLBACK_FAILURE_THRESHOLD; index++) guard.failed(counted)
    assert.deepEqual(published, ['read-only'])
})

test('classifyRisk 成功路径不打扰未安装的守卫', async () => {
    const { session, exec } = makeReviewSession()
    const { verdict } = await reviewOnce(session, exec, () => okResponse(answersWith(1)))
    assert.equal(verdict.kind, 'allow')
})
