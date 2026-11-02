import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ToolCallId, createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageSource, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { Session, SessionId, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session'
import { snapshotAutoReview } from '../src/snapshot.ts'
import type { HistoricalEntry, HistoricalToolSchema, ReviewSnapshot } from '../src/types.ts'

const PROBE_SCHEMA: ToolSchema = {
    name: 'probe',
    description: 'live probe description',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}

const INNER_SCHEMA: ToolSchema = {
    name: 'inner-tool',
    description: 'inner tool binding description',
    parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
}

const RUN_CODE_SCHEMA: ToolSchema = {
    name: 'run_code',
    description: 'run code description',
    parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
}

function makeSession(): Session {
    return Session.create(SessionId('s-snap'))
}

function appendHeader(session: Session, tools: readonly ToolSchema[], reason: 'initial' | 'change' = 'initial'): void {
    session.append('request/header', { header: { config: { provider: 'review', model: 'review-model' }, tools: [...tools] }, reason })
}

function appendUser(
    session: Session,
    content: readonly ContentBlock[],
    source: MessageSource,
    surfaceOp: 'append' | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq } = 'append',
    sourceEventSeqs?: readonly SessionSeq[],
): void {
    session.append('user/message', createUserMessage({ content: [...content], source }), {
        surfaceOp,
        ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs: [...sourceEventSeqs] }),
    })
}

function openStep(session: Session, turn: number, step: number): void {
    session.append('step/start', { turn, step })
}

function appendAssistant(session: Session, turn: number, step: number, content: readonly ContentBlock[]): void {
    session.append('assistant/message', {
        turn,
        step,
        stream: [],
        message: createAssistantMessage({
            content: [...content],
            source: { provider: 'review', model: 'review-model' },
        }),
    }, { surfaceOp: 'append' })
}

function appendCall(session: Session, turn: number, step: number, callId: string, name = 'probe', argumentsText = '{"path":"a.txt"}'): void {
    session.append('tool/call', { turn, step, callId: ToolCallId(callId), name, arguments: argumentsText })
}

/**
 * 追加一条 PTC 派发起始事件。该事件类型由上游 PTC 运行时写入，安装的
 * dsh-session 类型未含此成员（运行时事件表收录），测试侧显式声明其数据形状。
 */
function appendPtcStart(
    session: Session,
    turn: number,
    step: number,
    subCallId: string,
    parentCallId: string,
    name = 'inner-tool',
    argumentsValue: unknown = { code: 'return 1' },
): void {
    const append = session.append as unknown as (
        type: 'tool/ptc-dispatch-start',
        data: { turn: number; step: number; subCallId: ToolCallId; parentCallId: ToolCallId; rootCallId: ToolCallId; name: string; arguments: unknown },
    ) => SessionEvent
    // session.append 依赖实例状态，绕过缺失的类型增广时必须显式绑定 this。
    append.call(session, 'tool/ptc-dispatch-start', {
        turn,
        step,
        subCallId: ToolCallId(subCallId),
        parentCallId: ToolCallId(parentCallId),
        rootCallId: ToolCallId(parentCallId),
        name,
        arguments: argumentsValue,
    })
}

function nativeExec(callId: string): ToolExecution {
    return {
        callId: ToolCallId(callId),
        rootCallId: ToolCallId(callId),
        name: 'probe',
        arguments: { path: 'a.txt' },
        signal: new AbortController().signal,
    } as ToolExecution
}

/** 组装「PTC 内层待执行动作」：带绑定 schema 与不透明父令牌。schema 传 null 表示绑定缺失。 */
function ptcExec(
    callId: string,
    rootCallId: string,
    overrides: { name?: string; arguments?: unknown; schema?: ToolSchema | null } = {},
): ToolExecution {
    const schema = overrides.schema === undefined ? INNER_SCHEMA : overrides.schema
    return {
        callId: ToolCallId(callId),
        rootCallId: ToolCallId(rootCallId),
        parent: Symbol('ptc-parent') as ToolExecution['parent'],
        name: overrides.name ?? 'inner-tool',
        arguments: overrides.arguments ?? { code: 'return 1' },
        ...(schema === null ? {} : { schema }),
        signal: new AbortController().signal,
    } as ToolExecution
}

/** 组装「外层 run_code 根调用」的原生待执行动作。 */
function runCodeExec(callId: string): ToolExecution {
    return {
        callId: ToolCallId(callId),
        rootCallId: ToolCallId(callId),
        name: 'run_code',
        arguments: { code: 'return 1' },
        signal: new AbortController().signal,
    } as ToolExecution
}

function freeze(session: Session, exec: ToolExecution, shown: ReadonlyMap<string, HistoricalToolSchema> = new Map()): ReviewSnapshot {
    return snapshotAutoReview({ session } as unknown as Agent, exec, '/workspace', shown)
}

function asUserMessage(entry: HistoricalEntry): Extract<HistoricalEntry, { kind: 'user-message' }> {
    assert.equal(entry.kind, 'user-message')
    return entry
}

function asToolCall(entry: HistoricalEntry): Extract<HistoricalEntry, { kind: 'tool-call' }> {
    assert.equal(entry.kind, 'tool-call')
    return entry
}

function asSchema(entry: HistoricalEntry): Extract<HistoricalEntry, { kind: 'tool-schema' }> {
    assert.equal(entry.kind, 'tool-schema')
    return entry
}

/** 组装「当前步骤里的待审原生调用」这一最小可审形态。 */
function seedPendingCall(session: Session, callId: string, turn = 1, step = 1): ToolExecution {
    appendUser(session, [{ type: 'text', text: '清理本次会话生成的临时文件' }], { kind: 'user' })
    openStep(session, turn, step)
    appendAssistant(session, turn, step, [
        { type: 'text', text: '我来删除临时文件' },
        { type: 'tool-call', id: ToolCallId(callId), name: 'probe', arguments: '{"path":"a.txt"}' },
    ])
    appendCall(session, turn, step, callId)
    return nativeExec(callId)
}

test('待审 schema 取自最新请求头路由而非旧路由', () => {
    const session = makeSession()
    appendHeader(session, [{ ...PROBE_SCHEMA, description: '过期的 probe 描述' }])
    appendHeader(session, [{ ...PROBE_SCHEMA, description: '最新的 probe 描述' }], 'change')
    const exec = seedPendingCall(session, 'call-1')
    const snapshot = freeze(session, exec)
    const pendingSchema = snapshot.pending.schema
    assert.equal(pendingSchema.description, '最新的 probe 描述')
})

test('系统消息、工具结果与工具来源的用户消息不进入历史', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    // system-prompt 来源的 user 消息按普通非用户来源落为 fact；system/message 事件类型才被整体剔除。
    appendUser(session, [{ type: 'text', text: '注入的上下文' }], { kind: 'system-prompt' })
    session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('系统提示') }, { surfaceOp: 'append' })
    appendUser(session, [{ type: 'text', text: '工具回传的说明' }], { kind: 'tool', callId: ToolCallId('res-1') })
    session.append('tool/result', {
        turn: 1,
        step: 1,
        message: createToolResultMessage({ callId: ToolCallId('res-1'), content: [{ type: 'text', text: '执行结果' }], isError: false }),
    }, { surfaceOp: 'append' })
    const exec = seedPendingCall(session, 'call-1')
    const { history } = freeze(session, exec)
    assert.deepEqual(history.map(entry => entry.kind), ['user-message', 'user-message', 'assistant-claim', 'tool-schema', 'tool-call'])
    assert.equal(asUserMessage(history[0]!).role, 'fact')
    assert.equal(asUserMessage(history[1]!).role, 'user-instruction')
    assert.ok(!JSON.stringify(history).includes('系统提示'))
    assert.ok(!JSON.stringify(history).includes('工具回传的说明'))
    assert.ok(!JSON.stringify(history).includes('执行结果'))
})

test('历史助手消息不产生 claim，正文与推理块一律不落地', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    appendUser(session, [{ type: 'text', text: '按顺序处理' }], { kind: 'user' })
    openStep(session, 1, 1)
    appendAssistant(session, 1, 1, [
        { type: 'text', text: '第一步说明' },
        { type: 'reasoning', text: '内部推理' } as ContentBlock,
        { type: 'tool-call', id: ToolCallId('call-1'), name: 'probe', arguments: '{"path":"a.txt"}' },
    ])
    appendCall(session, 1, 1, 'call-1')
    openStep(session, 1, 2)
    appendAssistant(session, 1, 2, [
        { type: 'text', text: '第二步说明' },
        { type: 'tool-call', id: ToolCallId('call-2'), name: 'probe', arguments: '{"path":"a.txt"}' },
    ])
    appendCall(session, 1, 2, 'call-2')
    const { history } = freeze(session, nativeExec('call-2'))
    assert.deepEqual(history.map(entry => entry.kind), ['user-message', 'tool-call', 'assistant-claim', 'tool-schema', 'tool-call'])
    assert.equal(asToolCall(history[1]!).arguments, '{"path":"a.txt"}')
    assert.equal(history[2]!.kind === 'assistant-claim' ? history[2].text : '', '第二步说明')
    assert.ok(!JSON.stringify(history).includes('内部推理'))
    assert.ok(!JSON.stringify(history).includes('第一步说明'))
})

test('agent-instructions 落为 constraint，空内容整体跳过', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    const instructions = { kind: 'agent-instructions' } as unknown as MessageSource
    appendUser(session, [{ type: 'text', text: '工作区项目约束' }], instructions)
    appendUser(session, [], instructions)
    const exec = seedPendingCall(session, 'call-1')
    const { history } = freeze(session, exec)
    assert.deepEqual(history.map(entry => entry.kind), ['user-message', 'user-message', 'assistant-claim', 'tool-schema', 'tool-call'])
    assert.equal(asUserMessage(history[0]!).role, 'constraint')
    assert.equal(asUserMessage(history[1]!).role, 'user-instruction')
})

test('用户消息里的图片块落为 fact，文本块仍是 user-instruction', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    // 图片块在快照里只按类型路由，附件结构不参与审查输入。
    const image = { type: 'image', attachment: { id: 'att-1' } } as unknown as ContentBlock
    appendUser(session, [{ type: 'text', text: '请先看截图再动手' }, image], { kind: 'user' })
    const exec = seedPendingCall(session, 'call-1')
    const { history } = freeze(session, exec)
    const first = asUserMessage(history[0]!)
    assert.equal(first.role, 'user-instruction')
    const second = asUserMessage(history[1]!)
    assert.equal(second.role, 'fact')
    assert.deepEqual(second.content, [image])
})

test('compact-checkpoint 消息落为 checkpoint 角色', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    appendUser(session, [{ type: 'text', text: '压缩摘要' }], { kind: 'compact-checkpoint' } as unknown as MessageSource)
    const exec = seedPendingCall(session, 'call-1')
    const { history } = freeze(session, exec)
    assert.equal(asUserMessage(history[0]!).role, 'checkpoint')
})

test('surface replace 后原始用户授权整体消失，仅压缩摘要以 checkpoint 保留', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    const original = session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: '请删除所有日志文件' }],
        source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    appendUser(
        session,
        [{ type: 'text', text: '压缩摘要' }],
        { kind: 'compact-checkpoint' } as unknown as MessageSource,
        { op: 'replace', startSeq: original.seq, endSeq: original.seq },
        [original.seq],
    )
    const exec = seedPendingCall(session, 'call-1')
    const { history } = freeze(session, exec)
    const messages = history.filter(entry => entry.kind === 'user-message')
    // 待审调用自己的用户指令在场；被替换的原始授权必须消失。
    assert.deepEqual(messages.map(entry => asUserMessage(entry).role), ['checkpoint', 'user-instruction'])
    assert.ok(!JSON.stringify(history).includes('请删除所有日志文件'))
})

test('未启动的历史调用被剔除，不进入历史', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    appendUser(session, [{ type: 'text', text: '按顺序处理' }], { kind: 'user' })
    openStep(session, 1, 1)
    // 未启动调用在非当前消息里被剔除；待审调用属于后续步骤。
    appendAssistant(session, 1, 1, [
        { type: 'tool-call', id: ToolCallId('call-0'), name: 'probe', arguments: '{"path":"a.txt"}' },
    ])
    const exec = seedPendingCall(session, 'call-1', 1, 2)
    const { history } = freeze(session, exec)
    const calls = history.filter(entry => entry.kind === 'tool-call')
    assert.equal(calls.length, 1)
    assert.equal(asToolCall(calls[0]!).name, 'probe')
})

test('第二次审查完整包含第一次条目且同名 schema 只出现一次', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    appendUser(session, [{ type: 'text', text: '分两步处理' }], { kind: 'user' })
    openStep(session, 1, 1)
    appendAssistant(session, 1, 1, [
        { type: 'tool-call', id: ToolCallId('call-1'), name: 'probe', arguments: '{"path":"a.txt"}' },
    ])
    appendCall(session, 1, 1, 'call-1')
    const shown = new Map<string, HistoricalToolSchema>()
    const first = freeze(session, nativeExec('call-1'), shown)
    shown.set(first.pending.key, first.pending.schema)
    openStep(session, 1, 2)
    appendAssistant(session, 1, 2, [
        { type: 'tool-call', id: ToolCallId('call-2'), name: 'probe', arguments: '{"path":"a.txt"}' },
    ])
    appendCall(session, 1, 2, 'call-2')
    const second = freeze(session, nativeExec('call-2'), shown)
    assert.deepEqual(second.history.slice(0, first.history.length), [...first.history])
    assert.equal(second.history.filter(entry => entry.kind === 'tool-schema').length, 1)
    assert.ok(Object.isFrozen(second))
})

test('PTC 内层调用按派发记录与绑定 schema 送审，外层 run_code 进历史', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    appendUser(session, [{ type: 'text', text: '执行内层代码' }], { kind: 'user' })
    openStep(session, 1, 1)
    appendAssistant(session, 1, 1, [
        { type: 'text', text: '我来派发内层工具' },
        { type: 'tool-call', id: ToolCallId('root-1'), name: 'run_code', arguments: '{"code":"return 1"}' },
    ])
    appendCall(session, 1, 1, 'root-1', 'run_code', '{"code":"return 1"}')
    appendPtcStart(session, 1, 1, 'sub-1', 'root-1')
    const snapshot = freeze(session, ptcExec('sub-1', 'root-1'))
    assert.equal(snapshot.pending.key, ['ptc-inner', 1, 1, 'sub-1'].join('\0'))
    assert.equal(snapshot.pending.schema.mode, 'ptc-inner')
    assert.equal(snapshot.pending.schema.name, 'inner-tool')
    assert.deepEqual(snapshot.history.map(entry => entry.kind), ['user-message', 'assistant-claim', 'tool-call', 'tool-schema', 'tool-call'])
    const rootCall = asToolCall(snapshot.history[2]!)
    assert.equal(rootCall.mode, 'native')
    assert.equal(rootCall.name, 'run_code')
    assert.equal(rootCall.arguments, '{"code":"return 1"}')
    const pendingCall = asToolCall(snapshot.history[4]!)
    assert.equal(pendingCall.mode, 'ptc-inner')
    assert.equal(pendingCall.arguments, JSON.stringify({ code: 'return 1' }, null, 2))
})

test('native callId 跨步骤复用按步骤作用域区分：旧调用进历史、当前调用为待审', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    appendUser(session, [{ type: 'text', text: '分两步处理' }], { kind: 'user' })
    openStep(session, 1, 1)
    appendAssistant(session, 1, 1, [
        { type: 'tool-call', id: ToolCallId('dup'), name: 'probe', arguments: '{"path":"a.txt"}' },
    ])
    appendCall(session, 1, 1, 'dup')
    openStep(session, 1, 2)
    appendAssistant(session, 1, 2, [
        { type: 'tool-call', id: ToolCallId('dup'), name: 'probe', arguments: '{"path":"a.txt"}' },
    ])
    appendCall(session, 1, 2, 'dup')
    const snapshot = freeze(session, nativeExec('dup'))
    assert.equal(snapshot.pending.key, ['native', 1, 2, 'dup'].join('\0'))
    assert.deepEqual(snapshot.history.map(entry => entry.kind), ['user-message', 'tool-call', 'tool-schema', 'tool-call'])
    assert.equal(asToolCall(snapshot.history[1]!).mode, 'native')
})

test('同一步骤内 callId 重复记录判为原生调用歧义', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    appendUser(session, [{ type: 'text', text: '先做一步' }], { kind: 'user' })
    openStep(session, 1, 1)
    appendAssistant(session, 1, 1, [
        { type: 'tool-call', id: ToolCallId('dup'), name: 'probe', arguments: '{"path":"a.txt"}' },
    ])
    appendCall(session, 1, 1, 'dup')
    appendCall(session, 1, 1, 'dup')
    const exec = seedPendingCall(session, 'call-1', 1, 2)
    assert.throws(() => freeze(session, exec), /a native call identity is ambiguous in the session log/)
})

test('subCallId 跨步骤复用不歧义：旧派发进历史、当前派发为待审', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    appendUser(session, [{ type: 'text', text: '分两步执行内层调用' }], { kind: 'user' })
    openStep(session, 1, 1)
    appendAssistant(session, 1, 1, [
        { type: 'tool-call', id: ToolCallId('root-1'), name: 'run_code', arguments: '{"code":"return 1"}' },
    ])
    appendCall(session, 1, 1, 'root-1', 'run_code', '{"code":"return 1"}')
    appendPtcStart(session, 1, 1, 'sub-1', 'root-1')
    openStep(session, 1, 2)
    appendAssistant(session, 1, 2, [
        { type: 'tool-call', id: ToolCallId('root-2'), name: 'run_code', arguments: '{"code":"return 1"}' },
    ])
    appendCall(session, 1, 2, 'root-2', 'run_code', '{"code":"return 1"}')
    appendPtcStart(session, 1, 2, 'sub-1', 'root-2')
    const snapshot = freeze(session, ptcExec('sub-1', 'root-2'))
    assert.equal(snapshot.pending.key, ['ptc-inner', 1, 2, 'sub-1'].join('\0'))
    assert.deepEqual(snapshot.history.map(entry => entry.kind), ['user-message', 'tool-call', 'tool-call', 'tool-call', 'tool-schema', 'tool-call'])
    const oldDispatch = asToolCall(snapshot.history[2]!)
    assert.equal(oldDispatch.mode, 'ptc-inner')
    assert.equal(oldDispatch.name, 'inner-tool')
})

test('同一 subCallId 在同一步骤二次派发判为 PTC 身份歧义', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    appendUser(session, [{ type: 'text', text: '派发内层调用' }], { kind: 'user' })
    openStep(session, 1, 1)
    appendAssistant(session, 1, 1, [
        { type: 'tool-call', id: ToolCallId('root-1'), name: 'run_code', arguments: '{"code":"return 1"}' },
    ])
    appendCall(session, 1, 1, 'root-1', 'run_code', '{"code":"return 1"}')
    appendPtcStart(session, 1, 1, 'sub-1', 'root-1')
    appendPtcStart(session, 1, 1, 'sub-1', 'root-1')
    assert.throws(() => freeze(session, ptcExec('sub-1', 'root-1')), /a PTC call identity is ambiguous in the session log/)
})

test('PTC 待审动作缺少派发记录判为缺失或歧义', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    appendUser(session, [{ type: 'text', text: '派发内层调用' }], { kind: 'user' })
    openStep(session, 1, 1)
    appendAssistant(session, 1, 1, [
        { type: 'tool-call', id: ToolCallId('root-1'), name: 'run_code', arguments: '{"code":"return 1"}' },
    ])
    appendCall(session, 1, 1, 'root-1', 'run_code', '{"code":"return 1"}')
    assert.throws(() => freeze(session, ptcExec('sub-1', 'root-1')), /the pending PTC call is missing or ambiguous in the session log/)
})

test('无打开步骤的派发记录判为无归属步骤', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    appendPtcStart(session, 1, 1, 'sub-1', 'root-1')
    assert.throws(() => freeze(session, ptcExec('sub-1', 'root-1')), /a PTC call has no owning step in the session log/)
})

test('外层 run_code 待审时其下已记录派发以 PTC 内层条目进历史', () => {
    const session = makeSession()
    appendHeader(session, [RUN_CODE_SCHEMA])
    appendUser(session, [{ type: 'text', text: '执行内层代码' }], { kind: 'user' })
    openStep(session, 1, 1)
    appendAssistant(session, 1, 1, [
        { type: 'tool-call', id: ToolCallId('root-1'), name: 'run_code', arguments: '{"code":"return 1"}' },
    ])
    appendCall(session, 1, 1, 'root-1', 'run_code', '{"code":"return 1"}')
    appendPtcStart(session, 1, 1, 'sub-1', 'root-1')
    const snapshot = freeze(session, runCodeExec('root-1'))
    assert.equal(snapshot.pending.key, ['native', 1, 1, 'root-1'].join('\0'))
    assert.equal(snapshot.pending.schema.mode, 'native')
    assert.equal(snapshot.pending.schema.name, 'run_code')
    assert.deepEqual(snapshot.history.map(entry => entry.kind), ['user-message', 'tool-call', 'tool-schema', 'tool-call'])
    const dispatchEntry = asToolCall(snapshot.history[1]!)
    assert.equal(dispatchEntry.mode, 'ptc-inner')
    assert.equal(dispatchEntry.name, 'inner-tool')
    assert.equal(dispatchEntry.arguments, JSON.stringify({ code: 'return 1' }, null, 2))
})

// fail-closed 矩阵：任一卫语句失败即整体抛错，不产出部分快照。

test('请求头缺失时拒绝产出快照', () => {
    const session = makeSession()
    assert.throws(() => freeze(session, nativeExec('call-1')), /no complete request-header route is available/)
})

test('待审步骤已关闭时拒绝产出快照', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    appendUser(session, [{ type: 'text', text: '处理一次' }], { kind: 'user' })
    openStep(session, 1, 1)
    appendAssistant(session, 1, 1, [
        { type: 'tool-call', id: ToolCallId('call-1'), name: 'probe', arguments: '{"path":"a.txt"}' },
    ])
    appendCall(session, 1, 1, 'call-1')
    session.append('step/end', { turn: 1, step: 1 })
    assert.throws(() => freeze(session, nativeExec('call-1')), /the pending call has no open step in the session log/)
})

test('有待审日志但表面无可见块时拒绝产出快照', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    openStep(session, 1, 1)
    appendCall(session, 1, 1, 'call-1')
    assert.throws(() => freeze(session, nativeExec('call-1')), /the pending root call is missing from the current surface/)
})

test('根块可见但根日志缺失时拒绝产出快照', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    appendUser(session, [{ type: 'text', text: '处理一次' }], { kind: 'user' })
    openStep(session, 1, 1)
    appendAssistant(session, 1, 1, [
        { type: 'tool-call', id: ToolCallId('call-1'), name: 'probe', arguments: '{"path":"a.txt"}' },
    ])
    assert.throws(() => freeze(session, nativeExec('call-1')), /the pending root call is missing or ambiguous in the session log/)
})

test('当前消息里待审根之前的可见块缺日志时拒绝产出快照', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    appendUser(session, [{ type: 'text', text: '处理一次' }], { kind: 'user' })
    openStep(session, 1, 1)
    appendAssistant(session, 1, 1, [
        { type: 'tool-call', id: ToolCallId('ghost'), name: 'probe', arguments: '{}' },
        { type: 'tool-call', id: ToolCallId('call-1'), name: 'probe', arguments: '{"path":"a.txt"}' },
    ])
    appendCall(session, 1, 1, 'call-1')
    assert.throws(() => freeze(session, nativeExec('call-1')), /a visible call before the pending root is missing from the session log/)
})

test('待审根日志重复时拒绝产出快照', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    appendUser(session, [{ type: 'text', text: '处理一次' }], { kind: 'user' })
    openStep(session, 1, 1)
    appendAssistant(session, 1, 1, [
        { type: 'tool-call', id: ToolCallId('call-1'), name: 'probe', arguments: '{"path":"a.txt"}' },
    ])
    appendCall(session, 1, 1, 'call-1')
    appendCall(session, 1, 1, 'call-1')
    assert.throws(() => freeze(session, nativeExec('call-1')), /the pending root call is missing or ambiguous in the session log/)
})

test('当前表面出现重复的待审根块时拒绝产出快照', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    appendUser(session, [{ type: 'text', text: '处理一次' }], { kind: 'user' })
    openStep(session, 1, 1)
    const block = { type: 'tool-call' as const, id: ToolCallId('call-1'), name: 'probe', arguments: '{"path":"a.txt"}' }
    appendAssistant(session, 1, 1, [block, block])
    appendCall(session, 1, 1, 'call-1')
    assert.throws(() => freeze(session, nativeExec('call-1')), /the pending root call is ambiguous in the current surface/)
})

test('待审调用名与执行动作不符时拒绝产出快照', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    appendUser(session, [{ type: 'text', text: '处理一次' }], { kind: 'user' })
    openStep(session, 1, 1)
    appendAssistant(session, 1, 1, [
        { type: 'tool-call', id: ToolCallId('call-1'), name: 'other', arguments: '{}' },
    ])
    appendCall(session, 1, 1, 'call-1', 'other', '{}')
    const exec = {
        callId: ToolCallId('call-1'),
        rootCallId: ToolCallId('call-1'),
        name: 'probe',
        arguments: {},
        signal: new AbortController().signal,
    } as ToolExecution
    assert.throws(() => freeze(session, exec), /the pending native call disagrees with its logged action/)
})

test('待审调用参数与执行动作不符时拒绝产出快照', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    appendUser(session, [{ type: 'text', text: '处理一次' }], { kind: 'user' })
    openStep(session, 1, 1)
    appendAssistant(session, 1, 1, [
        { type: 'tool-call', id: ToolCallId('call-1'), name: 'probe', arguments: '{}' },
    ])
    appendCall(session, 1, 1, 'call-1', 'probe', '{}')
    assert.throws(() => freeze(session, nativeExec('call-1')), /the pending native call disagrees with its logged action/)
})

test('可见块与其日志记录名字不一致时拒绝产出快照', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    appendUser(session, [{ type: 'text', text: '处理一次' }], { kind: 'user' })
    openStep(session, 1, 1)
    appendAssistant(session, 1, 1, [
        { type: 'tool-call', id: ToolCallId('hist-1'), name: 'shown', arguments: '{}' },
        { type: 'tool-call', id: ToolCallId('call-1'), name: 'probe', arguments: '{"path":"a.txt"}' },
    ])
    appendCall(session, 1, 1, 'hist-1', 'logged', '{}')
    appendCall(session, 1, 1, 'call-1')
    assert.throws(() => freeze(session, nativeExec('call-1')), /a visible tool call disagrees with its logged action/)
})

test('可见调用序列在缺日志调用之后仍出现已启动调用时拒绝产出快照', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    appendUser(session, [{ type: 'text', text: '处理一次' }], { kind: 'user' })
    openStep(session, 1, 1)
    appendAssistant(session, 1, 1, [
        { type: 'tool-call', id: ToolCallId('call-1'), name: 'probe', arguments: '{}' },
        { type: 'tool-call', id: ToolCallId('mid'), name: 'probe', arguments: '{}' },
        { type: 'tool-call', id: ToolCallId('later'), name: 'probe', arguments: '{}' },
    ])
    appendCall(session, 1, 1, 'call-1', 'probe', '{}')
    appendCall(session, 1, 1, 'later', 'probe', '{}')
    assert.throws(() => freeze(session, nativeExec('call-1')), /visible native call logs do not form a started prefix/)
})

test('当前消息里待审根之前的调用日志重复时拒绝产出快照', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    appendUser(session, [{ type: 'text', text: '处理一次' }], { kind: 'user' })
    openStep(session, 1, 1)
    appendAssistant(session, 1, 1, [
        { type: 'tool-call', id: ToolCallId('dup'), name: 'probe', arguments: '{}' },
        { type: 'tool-call', id: ToolCallId('call-1'), name: 'probe', arguments: '{"path":"a.txt"}' },
    ])
    appendCall(session, 1, 1, 'dup', 'probe', '{}')
    appendCall(session, 1, 1, 'dup', 'probe', '{}')
    appendCall(session, 1, 1, 'call-1')
    assert.throws(() => freeze(session, nativeExec('call-1')), /a native call identity is ambiguous in the session log/)
})

test('未启动调用携带 PTC 派发日志时拒绝产出快照', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    appendUser(session, [{ type: 'text', text: '处理一次' }], { kind: 'user' })
    openStep(session, 1, 1)
    appendAssistant(session, 1, 1, [
        { type: 'tool-call', id: ToolCallId('call-1'), name: 'probe', arguments: '{"path":"a.txt"}' },
        { type: 'tool-call', id: ToolCallId('later'), name: 'run_code', arguments: '{"code":"probe()"}' },
    ])
    appendCall(session, 1, 1, 'call-1')
    appendPtcStart(session, 1, 1, 'sub-later', 'later')
    assert.throws(() => freeze(session, nativeExec('call-1')), /an unstarted visible call has logged PTC dispatches/)
})

test('待审工具名不在请求头中时拒绝产出快照', () => {
    const session = makeSession()
    appendHeader(session, [RUN_CODE_SCHEMA])
    appendUser(session, [{ type: 'text', text: '处理一次' }], { kind: 'user' })
    openStep(session, 1, 1)
    appendAssistant(session, 1, 1, [
        { type: 'tool-call', id: ToolCallId('call-1'), name: 'probe', arguments: '{"path":"a.txt"}' },
    ])
    appendCall(session, 1, 1, 'call-1')
    assert.throws(() => freeze(session, nativeExec('call-1')), /the pending native tool schema is missing or ambiguous/)
})

test('请求头中同名 schema 重复时拒绝产出快照', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA, PROBE_SCHEMA])
    appendUser(session, [{ type: 'text', text: '处理一次' }], { kind: 'user' })
    openStep(session, 1, 1)
    appendAssistant(session, 1, 1, [
        { type: 'tool-call', id: ToolCallId('call-1'), name: 'probe', arguments: '{"path":"a.txt"}' },
    ])
    appendCall(session, 1, 1, 'call-1')
    assert.throws(() => freeze(session, nativeExec('call-1')), /the pending native tool schema is missing or ambiguous/)
})

test('请求头 schema 缺少描述或参数声明时拒绝产出快照', () => {
    for (const schema of [{ name: 'probe', parameters: { type: 'object' } }, { name: 'probe', description: 'probe' }]) {
        const session = makeSession()
        appendHeader(session, [schema as never])
        appendUser(session, [{ type: 'text', text: '处理一次' }], { kind: 'user' })
        openStep(session, 1, 1)
        appendAssistant(session, 1, 1, [
            { type: 'tool-call', id: ToolCallId('call-1'), name: 'probe', arguments: '{"path":"a.txt"}' },
        ])
        appendCall(session, 1, 1, 'call-1')
        assert.throws(() => freeze(session, nativeExec('call-1')), /the pending native tool schema is incomplete/)
    }
})

test('PTC 父根调用无日志时拒绝产出快照', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    appendUser(session, [{ type: 'text', text: '派发内层调用' }], { kind: 'user' })
    openStep(session, 1, 1)
    appendPtcStart(session, 1, 1, 'sub-1', 'root-1')
    assert.throws(() => freeze(session, ptcExec('sub-1', 'root-1')), /the pending root call is missing or ambiguous in the session log/)
})

test('PTC 父块可见但父日志缺失时先拒绝根日志缺失', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    appendUser(session, [{ type: 'text', text: '派发内层调用' }], { kind: 'user' })
    openStep(session, 1, 1)
    appendAssistant(session, 1, 1, [
        { type: 'tool-call', id: ToolCallId('root-1'), name: 'run_code', arguments: '{"code":"return 1"}' },
    ])
    appendPtcStart(session, 1, 1, 'sub-1', 'root-1')
    assert.throws(() => freeze(session, ptcExec('sub-1', 'root-1')), /the pending root call is missing or ambiguous in the session log/)
})

test('执行动作根身份与派发记录根不符时拒绝产出快照', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    appendUser(session, [{ type: 'text', text: '派发内层调用' }], { kind: 'user' })
    openStep(session, 1, 1)
    appendAssistant(session, 1, 1, [
        { type: 'tool-call', id: ToolCallId('root-1'), name: 'run_code', arguments: '{"code":"return 1"}' },
    ])
    appendCall(session, 1, 1, 'root-1', 'run_code', '{"code":"return 1"}')
    appendPtcStart(session, 1, 1, 'sub-1', 'root-1')
    assert.throws(() => freeze(session, ptcExec('sub-1', 'other-root')), /the pending root call is missing or ambiguous in the session log/)
})

test('派发记录名与执行动作不符时拒绝产出快照', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    appendUser(session, [{ type: 'text', text: '派发内层调用' }], { kind: 'user' })
    openStep(session, 1, 1)
    appendAssistant(session, 1, 1, [
        { type: 'tool-call', id: ToolCallId('root-1'), name: 'run_code', arguments: '{"code":"return 1"}' },
    ])
    appendCall(session, 1, 1, 'root-1', 'run_code', '{"code":"return 1"}')
    appendPtcStart(session, 1, 1, 'sub-1', 'root-1', 'other')
    assert.throws(() => freeze(session, ptcExec('sub-1', 'root-1', { name: 'probe', arguments: {} })), /the pending PTC call disagrees with its logged action/)
})

test('派发记录参数与执行动作不符时拒绝产出快照', () => {
    const session = makeSession()
    appendHeader(session, [PROBE_SCHEMA])
    appendUser(session, [{ type: 'text', text: '派发内层调用' }], { kind: 'user' })
    openStep(session, 1, 1)
    appendAssistant(session, 1, 1, [
        { type: 'tool-call', id: ToolCallId('root-1'), name: 'run_code', arguments: '{"code":"return 1"}' },
    ])
    appendCall(session, 1, 1, 'root-1', 'run_code', '{"code":"return 1"}')
    appendPtcStart(session, 1, 1, 'sub-1', 'root-1', 'inner-tool', { other: true })
    assert.throws(() => freeze(session, ptcExec('sub-1', 'root-1', { arguments: {} })), /the pending PTC call disagrees with its logged action/)
})

test('PTC 绑定 schema 缺失或名字不符时拒绝产出快照', () => {
    for (const overrides of [{ schema: null }, { schema: { ...INNER_SCHEMA, name: 'other' } }]) {
        const session = makeSession()
        appendHeader(session, [PROBE_SCHEMA])
        appendUser(session, [{ type: 'text', text: '派发内层调用' }], { kind: 'user' })
        openStep(session, 1, 1)
        appendAssistant(session, 1, 1, [
            { type: 'tool-call', id: ToolCallId('root-1'), name: 'run_code', arguments: '{"code":"return 1"}' },
        ])
        appendCall(session, 1, 1, 'root-1', 'run_code', '{"code":"return 1"}')
        appendPtcStart(session, 1, 1, 'sub-1', 'root-1')
        assert.throws(() => freeze(session, ptcExec('sub-1', 'root-1', overrides)), /the pending PTC binding schema is missing or inconsistent/)
    }
})

test('PTC 绑定 schema 缺少描述或参数声明时拒绝产出快照', () => {
    for (const schema of [{ name: 'inner-tool', parameters: { type: 'object' } }, { name: 'inner-tool', description: 'inner' }]) {
        const session = makeSession()
        appendHeader(session, [PROBE_SCHEMA])
        appendUser(session, [{ type: 'text', text: '派发内层调用' }], { kind: 'user' })
        openStep(session, 1, 1)
        appendAssistant(session, 1, 1, [
            { type: 'tool-call', id: ToolCallId('root-1'), name: 'run_code', arguments: '{"code":"return 1"}' },
        ])
        appendCall(session, 1, 1, 'root-1', 'run_code', '{"code":"return 1"}')
        appendPtcStart(session, 1, 1, 'sub-1', 'root-1')
        assert.throws(() => freeze(session, ptcExec('sub-1', 'root-1', { schema: schema as never })), /the pending PTC tool schema is incomplete/)
    }
})
