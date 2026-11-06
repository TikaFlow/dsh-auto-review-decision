import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, mock } from 'node:test'
import { ToolCallId, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import { AUTO_PRESET } from '@deepseek-ai/dsh-permission-presets'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { FALLBACK_FAILURE_THRESHOLD } from '../src/shared/config.ts'
import { CREDENTIAL_REF, MIN_CONTEXT_TOKENS } from '../src/shared/config.ts'
import { byteLength } from '../src/shared/bytes.ts'
import { budgetState, historyBytes, resetBudget } from '../src/budget.ts'
import { setConfigInput } from '../src/config.ts'
import { decide } from '../src/reviewer.ts'
import { FAILURE, SystemOneCallError } from '../src/systemone-client.ts'
import { applyFallback, reviewStats, updateState } from '../src/stats.ts'
import { decisionQuestions } from '../src/questions.ts'
import type { ReviewVerdict } from '../src/questions.ts'
import { SCORE_QUESTION_IDS } from '../src/shared/questions.ts'
import type { SystemOneResponse } from '../src/systemone.ts'

/** 从源文件原样提取 REVIEW_POLICY，避免复制旧文本；源码读取以包根为基准，兼容编译产物运行。 */
const REVIEW_POLICY = (() => {
    const source = readFileSync(resolve(process.cwd(), 'src/reviewer.ts'), 'utf8')
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

/**
 * 单进程合跑时模块级配置会跨文件串扰：每条用例运行前挂载本文件配置、结束后还原，
 * 使环境配置在用例之间回到未设置状态。
 */
const configTest = (name: string, fn: () => unknown): void => {
    test(name, async () => {
        setConfigInput(() => configValues)
        installFallback()
        try { await fn() } finally { setConfigInput(() => undefined) }
    })
}

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

/** 在会话中追加一个独立的 probe 调用步骤，供构造长历史。 */
function appendProbeStep(session: Session, turn: number, callId: string, argumentsText: string): void {
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
        turn,
        step: 1,
        stream: [],
        message: createMessage({
            role: 'assistant',
            content: [{ type: 'tool-call', id: ToolCallId(callId), name: 'probe', arguments: argumentsText }],
            source: { kind: 'model', provider: 'review', model: 'review-model' },
        }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', {
        turn,
        step: 1,
        callId: ToolCallId(callId),
        name: 'probe',
        arguments: argumentsText,
    })
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
    const verdict = await decide(makeCtx({ value: API_KEY, source: 'test' }), makeAgent(session), exec, exec.signal, { fetchImpl: fetch })
    return { verdict, calls }
}

/** 排空微任务，让重试循环推进到下一次退避等待。 */
async function settle(): Promise<void> {
    await new Promise((resolve) => { setImmediate(resolve) })
}

/** 安装降级设施，并记录降级时的会话预设迁移。 */
function installFallback(
    sessions: readonly Session[] = [],
    defaultPreset = 'workspace-write',
): { presetCalls: Array<readonly [Session, string]> } {
    const presetCalls: Array<readonly [Session, string]> = []
    const ctx = new Context()
    ctx.provide('sessions', { list: () => [...sessions] })
    ctx.provide('permissionPresets', {
        current: () => AUTO_PRESET,
        set: (session: Session, preset: string) => { presetCalls.push([session, preset]) },
        defaultPreset,
    })
    applyFallback(ctx)
    return { presetCalls }
}

/** 在 mock 时钟下跑完一次 429 重试链（1/2/4/8/16 秒）并断言最终失败。 */
async function reviewRateLimited(session: Session, exec: ToolExecution): Promise<SystemOneCallError> {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const pending = reviewOnce(session, exec, () => new Response('{"error":{"message":"rate limited"}}', { status: 429 }))
            .catch((error: unknown) => error)
        await settle()
        for (const delay of [1000, 2000, 4000, 8000, 16000]) {
            mock.timers.tick(delay)
            await settle()
        }
        const error = await pending
        assert.ok(error instanceof SystemOneCallError, '429 重试耗尽后应抛出协议错误')
        assert.equal(error.status, 429)
        return error
    } finally {
        mock.timers.reset()
    }
}

configTest('请求体携带环境、策略原文、问题表与待审调用，密钥只出现在 Authorization 头', async () => {
    const { session, exec } = makeReviewSession()
    const { verdict, calls } = await reviewOnce(session, exec, () => okResponse(answersWith(1)))
    assert.equal(verdict.kind, 'allow')
    assert.equal(calls.length, 1)
    const { url, init } = calls[0]!
    assert.equal(url, ENDPOINT)
    assert.equal(init.method, 'POST')
    assert.equal(init.headers instanceof Headers ? (init.headers as Headers).get('Authorization') : undefined, `Bearer ${API_KEY}`)
    const body = JSON.parse(String(init.body)) as {
        model?: string
        state: {
            environment: { cwd: string }
            policy: string
            history: unknown[]
            pending: { name: string; arguments: unknown; schema: ToolSchema }
        }
        questions: unknown
    }
    assert.equal(body.model, 'review-model')
    assert.deepEqual(body.state.environment, { cwd: '/workspace' })
    assert.equal(body.state.policy, REVIEW_POLICY)
    assert.deepEqual(body.state.pending, { name: 'probe', arguments: { path: 'a.txt' }, schema: PROBE_SCHEMA })
    assert.equal(body.state.pending.schema.description, 'live probe description')
    assert.deepEqual(body.state.pending.schema.parameters, PROBE_SCHEMA.parameters)
    assert.deepEqual(Object.keys(body.state.pending.schema).sort(), ['description', 'name', 'parameters'])
    assert.deepEqual(body.questions, decisionQuestions())
    assert.ok(!String(init.body).includes(API_KEY))
})

configTest('请求体与整体一次序列化逐字节一致，字段顺序不变', async () => {
    const { session, exec } = makeReviewSession()
    const { calls } = await reviewOnce(session, exec, () => okResponse(answersWith(1)))
    const raw = String(calls[0]!.init.body)
    const body = JSON.parse(raw) as { state: unknown; questions: unknown; model: string }
    assert.equal(raw, JSON.stringify({ state: body.state, questions: body.questions, model: body.model }))
    assert.deepEqual(Object.keys(body), ['state', 'questions', 'model'])
})

configTest('history 依次携带用户指令、模型说明与历史调用，且不含工具 schema', async () => {
    const { session, exec } = makeReviewSession()
    const { calls } = await reviewOnce(session, exec, () => okResponse(answersWith(1)))
    const body = JSON.parse(String(calls[0]!.init.body)) as {
        state: { history: Array<{ kind: string; role?: string; name?: string; text?: string; arguments?: unknown }> }
    }
    const history = body.state.history
    assert.deepEqual(history.map(entry => [entry.kind, entry.role]), [
        ['user-message', 'user-instruction'],
        ['assistant-claim', 'fact'],
        ['tool-call', 'fact'],
    ])
    assert.ok(history.every(entry => entry.kind !== 'tool-schema'), 'history 中不应出现 tool-schema 角色')
    assert.equal(history[0]!.name, undefined)
    assert.equal(history[1]!.text, '我来删除临时文件')
    assert.equal(history[2]!.name, 'probe')
    assert.equal(history[2]!.arguments, '{"path":"a.txt"}')
})

configTest('长会话裁剪后待审 schema 仍随 pending 发出，历史不携带 schema', async () => {
    resetBudget()
    const saved = configValues.contextTokens
    configValues.contextTokens = MIN_CONTEXT_TOKENS
    try {
        // 插入超过保留窗口的历史；单条参数足以把预算挤到只剩末十条与待审调用。
        const { session } = makeReviewSession()
        const bulky = JSON.stringify({ path: 'x'.repeat(4096) })
        for (let turn = 2; turn <= 21; turn++) appendProbeStep(session, turn, `call-${String(turn)}`, bulky)
        appendProbeStep(session, 22, 'pending', '{"path":"a.txt"}')
        const pending = {
            callId: ToolCallId('pending'),
            rootCallId: ToolCallId('pending'),
            name: 'probe',
            arguments: { path: 'a.txt' },
            signal: new AbortController().signal,
        } as ToolExecution
        const { calls } = await reviewOnce(session, pending, () => okResponse(answersWith(1)))
        const body = JSON.parse(String(calls[0]!.init.body)) as {
            state: { history: Array<{ kind: string }>; pending: { schema: ToolSchema } }
        }
        assert.deepEqual(body.state.pending.schema, PROBE_SCHEMA, '裁剪后 pending 仍须携带完整 schema')
        assert.equal(body.state.pending.schema.description, 'live probe description')
        assert.deepEqual(body.state.pending.schema.parameters, PROBE_SCHEMA.parameters)
        // 历史确已裁剪，且任何情况下都不再出现 tool-schema 条目。
        assert.ok(body.state.history.some(entry => entry.kind === 'omitted'), '历史应已被裁剪')
        assert.ok(body.state.history.every(entry => entry.kind !== 'tool-schema'), 'history 中不应出现 tool-schema 角色')
        assert.equal(body.state.history.at(-1)?.kind, 'tool-call')
    } finally {
        configValues.contextTokens = saved
    }
})

configTest('全部问题通过判定线时结论为 allow', async () => {
    const { session, exec } = makeReviewSession()
    const { verdict } = await reviewOnce(session, exec, () => okResponse(answersWith(1)))
    assert.deepEqual(verdict, { kind: 'allow' })
})

configTest('总判定问题低于拒绝线时直接 deny', async () => {
    const { session, exec } = makeReviewSession()
    const { verdict } = await reviewOnce(session, exec, () => okResponse(answersWith(0.1)))
    assert.deepEqual(verdict, {
        kind: 'deny',
        reason: { en: 'This call failed the safety review', zh: '该调用未通过安全审查' },
    })
})

configTest('总分不足且高于拒绝线时落为 ask 并携带问题标签', async () => {
    const { session, exec } = makeReviewSession()
    // noul 足够高进入补偿通道，但 malice 的安全侧全押在「不确定」档：不满足放行、高于拒绝线。
    const { verdict } = await reviewOnce(session, exec, () => okResponse(answersWith(0.9, { id: 'malice', probabilities: { '2': 1 } })))
    assert.deepEqual(verdict, {
        kind: 'ask',
        reason: { en: 'malicious intent; execute anyway?', zh: '存在恶意意图，是否执行？' },
    })
})

configTest('参数明显违反契约时直接放行，不发出决策请求', async () => {
    const { session, exec } = makeReviewSession('{"path":123}')
    const { calls, fetch } = capturingFetch(() => { throw new Error('must not be called') })
    const verdict = await decide(makeCtx({ value: API_KEY, source: 'test' }), makeAgent(session), exec, exec.signal, { fetchImpl: fetch })
    assert.deepEqual(verdict, { kind: 'allow' })
    assert.equal(calls.length, 0)
})

configTest('用户白名单命中的工具免审且不发出决策请求', async () => {
    const { session, exec } = makeReviewSession()
    configValues.toolWhitelist = ['probe']
    try {
        const { calls, fetch } = capturingFetch(() => { throw new Error('must not be called') })
        const verdict = await decide(makeCtx({ value: API_KEY, source: 'test' }), makeAgent(session), exec, exec.signal, { fetchImpl: fetch })
        assert.deepEqual(verdict, { kind: 'allow' })
        assert.equal(calls.length, 0)
    } finally {
        configValues.toolWhitelist = []
    }
})

configTest('HTTP 非 200 归类为 status 失败并携带响应摘要', async () => {
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

configTest('200 但响应非协议结构时归类为 field 失败', async () => {
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

configTest('200 但响应不是 JSON 时归类为 parse 失败', async () => {
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

configTest('网络失败归类为 network，错误信息不含密钥', async () => {
    const { session, exec } = makeReviewSession()
    const { fetch } = capturingFetch(() => { throw new Error('connection refused') })
    await assert.rejects(
        decide(makeCtx({ value: API_KEY, source: 'test' }), makeAgent(session), exec, exec.signal, { fetchImpl: fetch }),
        (error: unknown) => {
            assert.ok(error instanceof SystemOneCallError)
            assert.equal(error.kind, FAILURE.network)
            assert.ok(error.message.includes('connection refused'))
            assert.ok(!error.message.includes(API_KEY))
            return true
        },
    )
})

configTest('无凭据时仍发起请求，以 public 占位', async () => {
    const { session, exec } = makeReviewSession()
    const { calls, fetch } = capturingFetch(() => okResponse(answersWith(1)))
    await decide(makeCtx(undefined), makeAgent(session), exec, exec.signal, { fetchImpl: fetch })
    assert.equal(calls.length, 1)
    assert.equal((calls[0]?.init.headers as Headers).get('Authorization'), 'Bearer public')
})

configTest('必填配置缺失时归类为 config 失败', async () => {
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

configTest('连续失败达阈值降级一次，之后不再重复迁移', () => {
    const { session } = makeReviewSession()
    const { presetCalls } = installFallback([session])
    for (let index = 1; index < FALLBACK_FAILURE_THRESHOLD; index++) updateState('failed')
    assert.deepEqual(presetCalls, [])
    updateState('failed')
    assert.deepEqual(presetCalls, [[session, 'workspace-write']])
    updateState('failed')
    assert.deepEqual(presetCalls, [[session, 'workspace-write']])
    assert.equal(reviewStats().fallbacks, 1)
})

configTest('中止类失败不改变计数，反复中止不累积', () => {
    installFallback()
    for (let index = 0; index < 5; index++) updateState('failed')
    assert.equal(reviewStats().consecutiveFailures, 5)
    for (let index = 0; index < FALLBACK_FAILURE_THRESHOLD * 2; index++) updateState('failed', { aborted: true })
    assert.equal(reviewStats().consecutiveFailures, 5)
})

configTest('429 清零且不计失败：连续限流也不累积、不降级', () => {
    const { presetCalls } = installFallback()
    for (let index = 0; index < 5; index++) updateState('failed')
    assert.equal(reviewStats().consecutiveFailures, 5)
    for (let index = 0; index < FALLBACK_FAILURE_THRESHOLD; index++) updateState('rateLimited')
    assert.equal(reviewStats().consecutiveFailures, 0)
    assert.deepEqual(presetCalls, [])
})

configTest('成功清零计数：失败后成功再失败不累计降级', () => {
    const { presetCalls } = installFallback()
    for (let index = 1; index < FALLBACK_FAILURE_THRESHOLD; index++) updateState('failed')
    updateState('succeeded')
    for (let index = 1; index < FALLBACK_FAILURE_THRESHOLD; index++) updateState('failed')
    assert.equal(reviewStats().consecutiveFailures, FALLBACK_FAILURE_THRESHOLD - 1)
    assert.deepEqual(presetCalls, [])
})

configTest('降级去向为 system 时实时读取宿主默认预设', () => {
    const { session } = makeReviewSession()
    const saved = configValues.onApiUnavailable
    configValues.onApiUnavailable = 'system'
    try {
        const { presetCalls } = installFallback([session], 'read-only')
        for (let index = 0; index < FALLBACK_FAILURE_THRESHOLD; index++) updateState('failed')
        assert.deepEqual(presetCalls, [[session, 'read-only']])
    } finally {
        configValues.onApiUnavailable = saved
    }
})

configTest('成功审查按预期记账', async () => {
    const { session, exec } = makeReviewSession()
    const { verdict } = await reviewOnce(session, exec, () => okResponse(answersWith(1)))
    assert.equal(verdict.kind, 'allow')
    assert.equal(reviewStats().succeeded, 1)
})

configTest('免审放行与参数预检放行都不清零已有失败计数', async () => {
    const { session, exec } = makeReviewSession()
    const { presetCalls } = installFallback([session])
    for (let index = 1; index < FALLBACK_FAILURE_THRESHOLD; index++) updateState('failed')
    assert.equal(reviewStats().consecutiveFailures, FALLBACK_FAILURE_THRESHOLD - 1)

    configValues.toolWhitelist = ['probe']
    try {
        const verdict = await decide(makeCtx({ value: API_KEY, source: 'test' }), makeAgent(session), exec, exec.signal, {
            fetchImpl: capturingFetch(() => { throw new Error('must not be called') }).fetch,
        })
        assert.deepEqual(verdict, { kind: 'allow' })
    } finally {
        configValues.toolWhitelist = []
    }
    assert.equal(reviewStats().consecutiveFailures, FALLBACK_FAILURE_THRESHOLD - 1)

    const invalid = makeReviewSession('{"path":123}')
    const verdict = await decide(makeCtx({ value: API_KEY, source: 'test' }), makeAgent(invalid.session), invalid.exec, invalid.exec.signal, {
        fetchImpl: capturingFetch(() => { throw new Error('must not be called') }).fetch,
    })
    assert.deepEqual(verdict, { kind: 'allow' })
    assert.equal(reviewStats().consecutiveFailures, FALLBACK_FAILURE_THRESHOLD - 1)

    // 下一次真实失败恰达阈值，证明本地放行没有把此前的计数清零。
    await assert.rejects(reviewOnce(session, exec, () => new Response('boom', { status: 500 })))
    assert.equal(reviewStats().consecutiveFailures, FALLBACK_FAILURE_THRESHOLD)
    assert.deepEqual(presetCalls, [[session, 'workspace-write']])
})

configTest('决策请求成功响应清零连续失败计数', async () => {
    const { session, exec } = makeReviewSession()
    installFallback()
    for (let index = 0; index < 5; index++) updateState('failed')
    assert.equal(reviewStats().consecutiveFailures, 5)
    const { verdict } = await reviewOnce(session, exec, () => okResponse(answersWith(1)))
    assert.equal(verdict.kind, 'allow')
    assert.equal(reviewStats().consecutiveFailures, 0)
})

configTest('最终 429 清零且不计失败，连续限流后计数仍为 0', async () => {
    const { session, exec } = makeReviewSession()
    installFallback()
    updateState('failed')
    assert.equal(reviewStats().consecutiveFailures, 1)
    await reviewRateLimited(session, exec)
    assert.equal(reviewStats().consecutiveFailures, 0)
    await reviewRateLimited(session, exec)
    assert.equal(reviewStats().consecutiveFailures, 0)
})

configTest('重试 2 次的审查：模型审查 +1、请求 +3、重试 +2', async () => {
    const { session, exec } = makeReviewSession()
    let attempt = 0
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const pending = reviewOnce(session, exec, () => {
            attempt++
            return attempt <= 2 ? new Response('{}', { status: 429 }) : okResponse(answersWith(1))
        })
        await settle()
        for (const delay of [1000, 2000]) {
            mock.timers.tick(delay)
            await settle()
        }
        const { verdict } = await pending
        assert.equal(verdict.kind, 'allow')
    } finally {
        mock.timers.reset()
    }
    const stats = reviewStats()
    assert.equal(stats.modelReviews, 1)
    assert.equal(stats.requests, 3)
    assert.equal(stats.retries, 2)
    assert.equal(stats.succeeded, 1)
    assert.equal(stats.rateLimited, 2)
    assert.equal(stats.requests, stats.succeeded + stats.failed + stats.rateLimited)
    assert.equal(stats.modelReviews, stats.configErrors + stats.requests - stats.retries)
})

configTest('非 429 失败逐次递增，连续达阈值触发一次降级', async () => {
    const { session, exec } = makeReviewSession()
    const { presetCalls } = installFallback([session])
    for (let index = 1; index <= FALLBACK_FAILURE_THRESHOLD; index++) {
        await assert.rejects(reviewOnce(session, exec, () => new Response('boom', { status: 500 })))
        assert.equal(reviewStats().consecutiveFailures, index)
    }
    assert.deepEqual(presetCalls, [[session, 'workspace-write']])
    // 已降级后继续失败不再重复迁移。
    await assert.rejects(reviewOnce(session, exec, () => new Response('boom', { status: 500 })))
    assert.equal(presetCalls.length, 1)
})

configTest('混合序列：失败×5 → 429 → 失败×5 不触发降级', async () => {
    const { session, exec } = makeReviewSession()
    const { presetCalls } = installFallback([session])
    for (let index = 0; index < 5; index++) {
        await assert.rejects(reviewOnce(session, exec, () => { throw new TypeError('fetch failed') }))
    }
    assert.equal(reviewStats().consecutiveFailures, 5)
    await reviewRateLimited(session, exec)
    assert.equal(reviewStats().consecutiveFailures, 0)
    for (let index = 0; index < 5; index++) {
        await assert.rejects(reviewOnce(session, exec, () => new Response('boom', { status: 500 })))
    }
    assert.equal(reviewStats().consecutiveFailures, 5)
    assert.deepEqual(presetCalls, [])
})

configTest('审查因中止失败后计数保持不变', async () => {
    const { session, exec } = makeReviewSession()
    installFallback()
    for (let index = 0; index < 5; index++) updateState('failed')
    assert.equal(reviewStats().consecutiveFailures, 5)
    const controller = new AbortController()
    controller.abort()
    const abortedExec = { ...exec, signal: controller.signal } as ToolExecution
    await assert.rejects(
        reviewOnce(session, abortedExec, () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            throw error
        }),
        (error: unknown) => error instanceof SystemOneCallError && error.kind === FAILURE.aborted,
    )
    assert.equal(reviewStats().consecutiveFailures, 5)
})

configTest('apply 重置统计后连续失败计数与降级标记归零', () => {
    const { session } = makeReviewSession()
    const first = installFallback([session])
    for (let index = 0; index < FALLBACK_FAILURE_THRESHOLD; index++) updateState('failed')
    assert.equal(reviewStats().degraded, true)
    assert.deepEqual(first.presetCalls, [[session, 'workspace-write']])

    // apply 先重置统计，再装降级设施。
    const second = installFallback([session])
    assert.equal(reviewStats().consecutiveFailures, 0)
    assert.equal(reviewStats().degraded, false)
    // 计数从零起算，首次失败不会继承旧值而直接降级。
    updateState('failed')
    assert.equal(reviewStats().consecutiveFailures, 1)
    assert.deepEqual(second.presetCalls, [])
})

/** 审查预算签名：与 reviewer 内部的拼接方式一致。 */
const BUDGET_SIGNATURE = 'http://review.test|false|review-model'
const BUDGET_CONTEXT_TOKENS = 24 * 1024

configTest('非 200/429 响应每次失败后回退因子，下一次审查预算随之收紧', async () => {
    resetBudget()
    const { session, exec } = makeReviewSession()
    for (const expected of [2.25, 2]) {
        await assert.rejects(
            reviewOnce(session, exec, () => new Response(JSON.stringify({ error: 'context length exceeded' }), { status: 400 })),
            (error: unknown) => {
                assert.ok(error instanceof SystemOneCallError)
                assert.equal(error.status, 400)
                return true
            },
        )
        assert.equal(budgetState()?.factor, expected)
    }
    const hardTokens = BUDGET_CONTEXT_TOKENS - Math.max(BUDGET_CONTEXT_TOKENS * 0.05, 1024)
    assert.equal(historyBytes(BUDGET_SIGNATURE, BUDGET_CONTEXT_TOKENS, 0), Math.floor(hardTokens * 2))
})

configTest('端点拒绝逐次计入因子回退，因子到下限后仍计；429 不计', async () => {
    resetBudget()
    const { session, exec } = makeReviewSession()
    installFallback()
    const rejected = (): Response => new Response(JSON.stringify({ error: 'context length exceeded' }), { status: 400 })
    for (let index = 1; index <= 7; index++) {
        await assert.rejects(reviewOnce(session, exec, rejected))
        // 到下限后因子不再减小，但每次拒绝仍计一次回退。
        assert.equal(reviewStats().factorFallbacks, index)
        assert.equal(budgetState()?.factor, index <= 5 ? 2.5 - 0.25 * index : 1.25)
    }

    const before = reviewStats().factorFallbacks
    await reviewRateLimited(session, exec)
    assert.equal(reviewStats().factorFallbacks, before)
    assert.equal(budgetState()?.factor, 1.25)
})

configTest('网络错误、超时、200 解析与字段失败都不回退因子', async () => {
    resetBudget()
    const { session, exec } = makeReviewSession()
    const failures: Array<() => Response> = [
        () => { throw new TypeError('fetch failed') },
        () => {
            const error = new Error('timed out')
            error.name = 'TimeoutError'
            throw error
        },
        () => new Response('<html>gateway</html>', { status: 200 }),
        () => new Response(JSON.stringify({ result: { model: 'x' } }), { status: 200 }),
    ]
    for (const respond of failures) {
        await assert.rejects(reviewOnce(session, exec, respond))
        // 裁剪阶段会建立账本；这些与字节密度无关的失败不得改动因子与累计量。
        assert.equal(budgetState()?.factor, 2.5, '与字节密度无关的失败不应回退因子')
        assert.equal(budgetState()?.totalBytes, 0)
        assert.equal(budgetState()?.totalTokens, 0)
    }
})

configTest('成功响应仍按 usage 观测校准因子', async () => {
    resetBudget()
    const { session, exec } = makeReviewSession()
    const { verdict, calls } = await reviewOnce(session, exec, () => okResponse({
        ...answersWith(1),
        usage: { input_tokens: 500 },
    }))
    assert.equal(verdict.kind, 'allow')
    const bodyBytes = byteLength(String(calls[0]!.init.body))
    assert.equal(budgetState()?.totalBytes, bodyBytes)
    assert.equal(budgetState()?.factor, bodyBytes / 500)
})
