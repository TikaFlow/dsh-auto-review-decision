import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ToolCallId, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { AUTO_PRESET } from '@deepseek-ai/dsh-permission-presets'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { setConfigInput } from '../src/config.ts'
import { applyLifecycle } from '../src/lifecycle.ts'
import { SCORE_QUESTION_IDS } from '../src/shared/questions.ts'
import type { SystemOneResponse } from '../src/systemone.ts'

/** 审查所需的配置段；用例可就地改写后复原。 */
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
        try { await fn() } finally { setConfigInput(() => undefined) }
    })
}

const PROBE_SCHEMA: ToolSchema = {
    name: 'probe',
    description: 'live probe description',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}

/** 组装最小可审会话：请求头、用户指令、当前步骤里的说明与原生调用。 */
function makeSession(): Session {
    const session = Session.create(SessionId('s-lifecycle'))
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
                { type: 'tool-call', id: ToolCallId('call-1'), name: 'probe', arguments: '{"path":"a.txt"}' },
            ],
            source: { kind: 'model', provider: 'review', model: 'review-model' },
        }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', {
        turn: 1,
        step: 1,
        callId: ToolCallId('call-1'),
        name: 'probe',
        arguments: '{"path":"a.txt"}',
    })
    return session
}

/** 组装闸门入参；无 agent 或改名等变体就地覆盖。 */
function makeExec(session: Session, overrides: Partial<ToolExecution> = {}): ToolExecution {
    return {
        callId: ToolCallId('call-1'),
        rootCallId: ToolCallId('call-1'),
        name: 'probe',
        arguments: { path: 'a.txt' },
        agent: { session } as Agent,
        signal: new AbortController().signal,
        ...overrides,
    } as ToolExecution
}

/** 记录迁移与准入的 permissionPresets 桩。 */
interface PresetsStub {
    readonly setCalls: Array<readonly [Session, string]>
    readonly admits: Array<() => void>
    current: (session: Session) => string
    readonly defaultPreset: string
}

/**
 * 最小宿主：真实 cordis 上下文，只提供 applyLifecycle 及其审查路径消费的服务。
 * 闸门以插件子 scope 加载：根 fiber 的 dispose 语义是重启（卸载后重载），
 * 只有插件 fiber 的 dispose 才是生产语义的真卸载。
 */
function makeHost(autoSessions: readonly Session[], nonAutoSessions: readonly Session[] = []): {
    ctx: Context
    fiber: Fiber & PromiseLike<Fiber>
    presets: PresetsStub
} {
    const presets: PresetsStub = {
        setCalls: [],
        admits: [],
        current: session => autoSessions.includes(session) ? AUTO_PRESET : 'workspace-write',
        defaultPreset: 'workspace-write',
    }
    const ctx = new Context()
    ctx.provide('permissionPresets', {
        current: (session: Session) => presets.current(session),
        registerAuto: (admit: () => void) => {
            presets.admits.push(admit)
            return () => { }
        },
        set: (session: Session, preset: string) => { presets.setCalls.push([session, preset]) },
        defaultPreset: presets.defaultPreset,
    })
    ctx.provide('credentials', { resolve: async () => ({ value: 'test-secret-key', source: 'test' }) })
    ctx.provide('workingDirectory', { ensure: async () => '/workspace' })
    ctx.provide('sessions', { list: () => [...autoSessions, ...nonAutoSessions] })
    const fiber = ctx.plugin(applyLifecycle)
    return { ctx, fiber, presets }
}

/** 临时替换全局 fetch 并计数；测试结束必须调用 restore。 */
function useFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): {
    count: () => number
    restore: () => void
} {
    const original = globalThis.fetch
    let count = 0
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        count += 1
        return impl(input, init)
    }) as typeof fetch
    return { count: () => count, restore: () => { globalThis.fetch = original } }
}

/** 在 init.signal 中止时拒绝的 fetch 桩；已中止的 signal 不会触发事件，须先查初值。 */
function abortAwareFetch(): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
    return (_input, init) => new Promise((_resolve, reject) => {
        const signal = init?.signal
        if (signal?.aborted) {
            reject(new Error('aborted'))
            return
        }
        signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })
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

/** 决策接口 200 信封响应。 */
function okResponse(payload: SystemOneResponse): Response {
    return new Response(JSON.stringify({ result: payload }), { status: 200 })
}

/** 闸门触发器：记录下游调用并回放给定决定。 */
function makeNext(decision: PreToolDecision): { next: () => Promise<PreToolDecision>; calls: () => number } {
    let calls = 0
    return {
        next: async () => {
            calls += 1
            return decision
        },
        calls: () => calls,
    }
}

configTest('审查通过后放行，下游 next 被真实调用', async () => {
    const session = makeSession()
    const { ctx, fiber } = makeHost([session])
    await fiber
    const fetchStub = useFetch(() => Promise.resolve(okResponse(answersWith(1))))
    try {
        const { next, calls } = makeNext({ kind: 'allow' })
        const decision = await ctx.waterfall('tools/pre-execute', makeExec(session), next)
        assert.deepEqual(decision, { kind: 'allow' })
        assert.equal(calls(), 1)
        assert.equal(fetchStub.count(), 1)
    } finally {
        fetchStub.restore()
    }
})

configTest('审查落入补偿通道时向宿主产出审批询问决定', async () => {
    const session = makeSession()
    const { ctx, fiber } = makeHost([session])
    await fiber
    const fetchStub = useFetch(() => Promise.resolve(okResponse(answersWith(0.9, { id: 'malice', probabilities: { '2': 1 } }))))
    try {
        const { next, calls } = makeNext({ kind: 'allow' })
        const decision = await ctx.waterfall('tools/pre-execute', makeExec(session), next)
        assert.equal(decision.kind, 'ask')
        assert.ok(decision.kind === 'ask' && decision.reason?.includes('存在恶意意图'))
        assert.ok(decision.kind === 'ask' && typeof decision.displayReason?.en === 'string')
        assert.equal(calls(), 1)
    } finally {
        fetchStub.restore()
    }
})

configTest('审查原则拒绝时直接落地拒绝，不询问也不执行下游', async () => {
    const session = makeSession()
    const { ctx, fiber } = makeHost([session])
    await fiber
    const fetchStub = useFetch(() => Promise.resolve(okResponse(answersWith(0.1))))
    try {
        const { next, calls } = makeNext({ kind: 'allow' })
        const decision = await ctx.waterfall('tools/pre-execute', makeExec(session), next)
        assert.deepEqual(decision, {
            kind: 'deny',
            reason: 'Auto review rejected tool "probe"; its body was not executed',
            info: { name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED', reason: '该调用未通过安全审查' },
        })
        assert.equal(calls(), 0)
    } finally {
        fetchStub.restore()
    }
})

configTest('审查失败时落地独立失败身份，工具体不执行', async () => {
    const session = makeSession()
    const { ctx, fiber } = makeHost([session])
    await fiber
    const fetchStub = useFetch(() => Promise.resolve(new Response('boom', { status: 500 })))
    try {
        const { next, calls } = makeNext({ kind: 'allow' })
        const decision = await ctx.waterfall('tools/pre-execute', makeExec(session), next)
        assert.ok(decision.kind === 'deny')
        assert.ok(decision.kind === 'deny' && decision.info?.name === 'AutoReviewFailedError')
        assert.ok(decision.kind === 'deny' && decision.info?.code === 'AUTO_REVIEW_FAILED')
        assert.ok(decision.kind === 'deny' && decision.reason.includes('HTTP 500'))
        assert.equal(calls(), 0)
    } finally {
        fetchStub.restore()
    }
})

configTest('审查要求询问但下游守卫拒绝时，直接落地下游拒绝而不弹审批', async () => {
    const session = makeSession()
    const { ctx, fiber } = makeHost([session])
    await fiber
    const fetchStub = useFetch(() => Promise.resolve(okResponse(answersWith(0.9, { id: 'malice', probabilities: { '2': 1 } }))))
    try {
        const downstream: PreToolDecision = { kind: 'deny', reason: '下游守卫拒绝' }
        const { next, calls } = makeNext(downstream)
        const decision = await ctx.waterfall('tools/pre-execute', makeExec(session), next)
        assert.deepEqual(decision, downstream)
        assert.equal(calls(), 1)
    } finally {
        fetchStub.restore()
    }
})

configTest('审查放行但下游拒绝时保持下游拒绝', async () => {
    const session = makeSession()
    const { ctx, fiber } = makeHost([session])
    await fiber
    const fetchStub = useFetch(() => Promise.resolve(okResponse(answersWith(1))))
    try {
        const downstream: PreToolDecision = { kind: 'deny', reason: '下游守卫拒绝' }
        const { next, calls } = makeNext(downstream)
        const decision = await ctx.waterfall('tools/pre-execute', makeExec(session), next)
        assert.deepEqual(decision, downstream)
        assert.equal(calls(), 1)
    } finally {
        fetchStub.restore()
    }
})

configTest('无 agent 的调用不送审', async () => {
    const session = makeSession()
    const { ctx, fiber } = makeHost([session])
    await fiber
    const fetchStub = useFetch(() => { throw new Error('must not be called') })
    try {
        const { next, calls } = makeNext({ kind: 'allow' })
        const decision = await ctx.waterfall('tools/pre-execute', makeExec(session, { agent: undefined }), next)
        assert.deepEqual(decision, { kind: 'allow' })
        assert.equal(calls(), 1)
        assert.equal(fetchStub.count(), 0)
    } finally {
        fetchStub.restore()
    }
})

configTest('非 Auto 预设的调用不送审', async () => {
    const session = makeSession()
    const { ctx, fiber } = makeHost([], [session])
    await fiber
    const fetchStub = useFetch(() => { throw new Error('must not be called') })
    try {
        const { next, calls } = makeNext({ kind: 'allow' })
        const decision = await ctx.waterfall('tools/pre-execute', makeExec(session), next)
        assert.deepEqual(decision, { kind: 'allow' })
        assert.equal(calls(), 1)
        assert.equal(fetchStub.count(), 0)
    } finally {
        fetchStub.restore()
    }
})

configTest('无外层父调用的 run_code 不送审', async () => {
    const session = makeSession()
    const { ctx, fiber } = makeHost([session])
    await fiber
    const fetchStub = useFetch(() => { throw new Error('must not be called') })
    try {
        const { next, calls } = makeNext({ kind: 'allow' })
        const exec = makeExec(session, { name: 'run_code', callId: ToolCallId('rc-1'), rootCallId: ToolCallId('rc-1'), parent: undefined })
        const decision = await ctx.waterfall('tools/pre-execute', exec, next)
        assert.deepEqual(decision, { kind: 'allow' })
        assert.equal(calls(), 1)
        assert.equal(fetchStub.count(), 0)
    } finally {
        fetchStub.restore()
    }
})

configTest('卸载排空时在途审查落为取消，工具体不执行且卸载不悬挂', async () => {
    const session = makeSession()
    const { ctx, fiber } = makeHost([session])
    await fiber
    const fetchStub = useFetch(abortAwareFetch())
    try {
        const { next, calls } = makeNext({ kind: 'allow' })
        const pending = ctx.waterfall('tools/pre-execute', makeExec(session), next)
        await fiber.dispose()
        const decision = await pending
        assert.deepEqual(decision, { kind: 'cancel' })
        assert.equal(calls(), 0)
    } finally {
        fetchStub.restore()
    }
})

configTest('调用方中止优先于未落地的审查结果', async () => {
    const session = makeSession()
    const { ctx, fiber } = makeHost([session])
    await fiber
    const fetchStub = useFetch(abortAwareFetch())
    try {
        const controller = new AbortController()
        const { next, calls } = makeNext({ kind: 'allow' })
        const pending = ctx.waterfall('tools/pre-execute', makeExec(session, { signal: controller.signal }), next)
        controller.abort()
        const decision = await pending
        assert.ok(decision.kind === 'deny')
        assert.ok(decision.kind === 'deny' && decision.info?.code === 'AUTO_REVIEW_FAILED')
        assert.equal(calls(), 0)
    } finally {
        fetchStub.restore()
    }
})

configTest('卸载时只把仍处于 Auto 的会话迁到退出预设', async () => {
    const autoSession = makeSession()
    const otherSession = Session.create(SessionId('s-other'))
    const { ctx, fiber, presets } = makeHost([autoSession], [otherSession])
    await fiber
    configValues.onSessionReset = 'read-only'
    try {
        await fiber.dispose()
        assert.equal(presets.setCalls.length, 1)
        assert.ok(presets.setCalls[0]?.[0] === autoSession)
        assert.equal(presets.setCalls[0]?.[1], 'read-only')
    } finally {
        configValues.onSessionReset = 'workspace-write'
    }
})

configTest('退出预设为 system 时实时解析为宿主默认预设', async () => {
    const autoSession = makeSession()
    const { ctx, fiber, presets } = makeHost([autoSession])
    await fiber
    configValues.onSessionReset = 'system'
    try {
        await fiber.dispose()
        assert.deepEqual(presets.setCalls, [[autoSession, 'workspace-write']])
    } finally {
        configValues.onSessionReset = 'workspace-write'
    }
})

configTest('卸载后新调用不再送审，监听器已注销直接放行下游', async () => {
    const session = makeSession()
    const { ctx, fiber } = makeHost([session])
    await fiber
    await fiber.dispose()
    const fetchStub = useFetch(() => { throw new Error('must not be called') })
    try {
        const { next, calls } = makeNext({ kind: 'allow' })
        const decision = await ctx.waterfall('tools/pre-execute', makeExec(session), next)
        assert.deepEqual(decision, { kind: 'allow' })
        assert.equal(calls(), 1)
        assert.equal(fetchStub.count(), 0)
    } finally {
        fetchStub.restore()
    }
})

configTest('集成关闭后 registerAuto 准入检查抛错，关闭前不抛', async () => {
    const autoSession = makeSession()
    const { ctx, fiber, presets } = makeHost([autoSession])
    await fiber
    assert.equal(presets.admits.length, 1)
    assert.doesNotThrow(() => presets.admits[0]?.())
    await fiber.dispose()
    assert.throws(() => presets.admits[0]?.(), /integration is closing/)
})
