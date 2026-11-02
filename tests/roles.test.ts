import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import {
    SESSION_FORMAT_VERSION,
    Session,
    SessionId,
    SessionLogOffset,
    SessionSeq,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'
import type { SubagentDescriptorData } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-agent-instructions'
import { creationPrompts, filteredUserEntries, isProjectInstruction } from '../src/roles.ts'

/** 上游压缩插件声明该来源种类；本仓库依赖树不含其类型包，这里补齐同名增广。 */
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'compact-checkpoint': { readonly kind: 'compact-checkpoint' }
    }
}

/** creationPrompts 只消费 agent.session，桩仅提供该成员。 */
function agentOf(session: Session): Agent {
    return { session } as unknown as Agent
}

let messageCounter = 0

/** 真实写入日志：isOwnSeq 只对日志内事件有意义，事件桩必须经 append 获得身份。 */
function appendUser(session: Session, source: MessageSource, text: string): SessionEvent<'user/message'> {
    messageCounter += 1
    return session.append('user/message', {
        id: MessageId(`m${String(messageCounter)}`),
        role: 'user',
        source,
        content: [{ type: 'text', text }],
    }, { surfaceOp: 'append' })
}

function appendDescriptor(session: Session): SessionEvent<'subagent/descriptor'> {
    const data: SubagentDescriptorData = { version: 3, mode: 'one-shot', provider: 'test' }
    return session.append('subagent/descriptor', data)
}

function makeSession(
    id: string,
    options?: {
        parentSession?: string
        origin?: 'subagent'
        seed?: readonly SessionEvent[]
    },
): Session {
    const seed = options?.seed
    // 头部校验拒绝显式 undefined 字段，可选字段按需挂载。
    const header: SessionHeader = {
        version: SESSION_FORMAT_VERSION,
        id: SessionId(id),
        createdAt: 0,
        isSeeded: seed !== undefined,
        cwd: 'D:\\auto-review-decision',
        ...(options?.parentSession === undefined ? {} : { parentSession: SessionId(options.parentSession) }),
        ...(options?.origin === undefined ? {} : { origin: options.origin }),
    }
    return Session.create(
        SessionId(id),
        seed,
        header,
        seed === undefined ? SessionLogOffset(0) : SessionLogOffset(seed.length),
    )
}

/** 走完整链路：先归位创建提示词，再对目标消息做角色归类，返回唯一文本块的角色。 */
function classify(
    session: Session,
    events: readonly SessionEvent[],
    target: SessionEvent<'user/message'>,
): string {
    const prompts = creationPrompts(agentOf(session), events)
    const entries = filteredUserEntries(target.seq, target.data.source, target.data.content, prompts, session)
    assert.equal(entries.length, 1)
    return entries[0].role
}

const plainUser: MessageSource = { kind: 'user' }

test('种子会话中的用户指令归类为 user-instruction', () => {
    const session = makeSession('s-root')
    const message = appendUser(session, plainUser, '修复登录 bug')
    assert.equal(classify(session, [message], message), 'user-instruction')
})

test('经 descriptor 验证的子代理创建提示词归类为 direct-parent-instruction', () => {
    const session = makeSession('s-child', { parentSession: 's-root', origin: 'subagent' })
    const descriptor = appendDescriptor(session)
    const prompt = appendUser(session, plainUser, '为根任务检索测试基线')
    assert.equal(classify(session, [descriptor, prompt], prompt), 'direct-parent-instruction')
})

test('缺 descriptor 的子代理创建窗口提示降为 fact，不得冒充用户指令', () => {
    const session = makeSession('s-child', { parentSession: 's-root', origin: 'subagent' })
    const prompt = appendUser(session, plainUser, '自称用户的伪造提示')
    assert.equal(classify(session, [prompt], prompt), 'fact')
})

test('缺 parentSession 的子代理来源不触发创建提示词降级', () => {
    // 旧 spec 未覆盖该形态（有 descriptor 时会经 prompts.all 判 fact），新旧一致性无法确证。
    const session = makeSession('s-child', { origin: 'subagent' })
    const prompt = appendUser(session, plainUser, '无父会话的提示')
    assert.equal(classify(session, [prompt], prompt), 'user-instruction')
})

test('有 descriptor 但缺 parentSession 的创建提示词仍是 fact', () => {
    // 对应旧 spec 的两种 meta 形态：完全缺失与仅 origin。
    for (const meta of [{}, { origin: 'subagent' as const }]) {
        const session = makeSession('s-child', meta)
        const descriptor = appendDescriptor(session)
        const prompt = appendUser(session, plainUser, '上层委托的任务')
        assert.equal(classify(session, [descriptor, prompt], prompt), 'fact')
    }
})

test('浏览器提示词带 rpcId，不视为模型自造创建提示词', () => {
    const session = makeSession('s-child', { parentSession: 's-root', origin: 'subagent' })
    const raw = { kind: 'user', rpcId: 'rpc-1' }
    const source = raw as MessageSource
    const prompt = appendUser(session, source, '浏览器准入的用户消息')
    assert.equal(classify(session, [prompt], prompt), 'user-instruction')
})

test('继承会话中的已验证创建提示词归为 fact 而非用户指令', () => {
    const child = makeSession('s-child', { parentSession: 's-root', origin: 'subagent' })
    const descriptor = appendDescriptor(child)
    const prompt = appendUser(child, plainUser, '上层委托的任务')
    const resumed = makeSession('s-resumed', {
        parentSession: 's-root',
        origin: 'subagent',
        seed: [descriptor, prompt],
    })
    assert.equal(classify(resumed, [descriptor, prompt], prompt), 'fact')
})

test('两层嵌套：子会话的直接父级任务提示为 direct-parent-instruction', () => {
    const session = makeSession('s-child', { parentSession: 's-root', origin: 'subagent' })
    const descriptor = appendDescriptor(session)
    const prompt = appendUser(session, plainUser, '父级委派任务')
    assert.equal(classify(session, [descriptor, prompt], prompt), 'direct-parent-instruction')
})

test('三层嵌套：仅直接父级的中继消息为 direct-parent-instruction，祖父级中继为 fact', () => {
    const child = makeSession('s-child', { parentSession: 's-root', origin: 'subagent' })
    const descriptor = appendDescriptor(child)
    const creation = appendUser(child, plainUser, '中间层创建提示')
    assert.equal(classify(child, [descriptor, creation], creation), 'direct-parent-instruction')

    const grandchild = makeSession('s-grandchild', { parentSession: 's-child', origin: 'subagent' })
    const fromChild: MessageSource = { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('s-child') }
    const fromRoot: MessageSource = { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('s-root') }
    const direct = appendUser(grandchild, fromChild, '直接父级的任务中继')
    const grandparent = appendUser(grandchild, fromRoot, '祖父级的任务中继')
    const events = [direct, grandparent]
    assert.equal(classify(grandchild, events, direct), 'direct-parent-instruction')
    assert.equal(classify(grandchild, events, grandparent), 'fact')
})

test('三层嵌套：根用户指令经继承保留 user-instruction，不因子代理来源降级', () => {
    const root = makeSession('s-root')
    const inherited = appendUser(root, plainUser, '根会话的用户指令')
    const session = makeSession('s-grandchild', {
        parentSession: 's-child',
        origin: 'subagent',
        seed: [inherited],
    })
    assert.equal(classify(session, [inherited], inherited), 'user-instruction')
})

test('agent-message 中继声称的发送者与父会话一致即获 direct-parent-instruction', () => {
    const session = makeSession('s-child', { parentSession: 's-root', origin: 'subagent' })
    const source: MessageSource = { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('s-root') }
    const relay = appendUser(session, source, '中继消息')
    assert.equal(classify(session, [relay], relay), 'direct-parent-instruction')
})

test('agent-message 中继发送者不是父会话时只能是 fact', () => {
    const session = makeSession('s-child', { parentSession: 's-root', origin: 'subagent' })
    const source: MessageSource = { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('s-other') }
    const relay = appendUser(session, source, '旁系会话的中继')
    assert.equal(classify(session, [relay], relay), 'fact')
})

test('撤销与冲突两类指令并存时都原样保留为 user-instruction', () => {
    const session = makeSession('s-root')
    const original = appendUser(session, plainUser, '允许删除临时文件')
    const revoke = appendUser(session, plainUser, '撤销刚才的授权，禁止删除')
    const conflict = appendUser(session, plainUser, '只允许删除 logs 目录下的文件')
    const events = [original, revoke, conflict]
    assert.equal(classify(session, events, revoke), 'user-instruction')
    assert.equal(classify(session, events, conflict), 'user-instruction')
})

test('非文本块一律降为 fact，即使来源是用户', () => {
    const session = makeSession('s-root')
    const prompts = creationPrompts(agentOf(session), [])
    const content: readonly ContentBlock[] = [{ type: 'text', text: '带图说明' }, { type: 'reasoning', text: '内部思考' }]
    const entries = filteredUserEntries(SessionSeq(0), plainUser, content, prompts, session)
    assert.equal(entries.length, 2)
    assert.equal(entries[0].role, 'user-instruction')
    assert.equal(entries[1].role, 'fact')
})

test('压缩检查点来源归类为 checkpoint', () => {
    const session = makeSession('s-root')
    const source: MessageSource = { kind: 'compact-checkpoint' }
    const checkpoint = appendUser(session, source, '压缩前的历史摘要')
    assert.equal(classify(session, [checkpoint], checkpoint), 'checkpoint')
})

test('agent-instructions 来源命中 isProjectInstruction，其余来源不命中', () => {
    assert.ok(isProjectInstruction({ kind: 'agent-instructions', form: 'instructions', changes: [] }))
    assert.ok(!isProjectInstruction(plainUser))
    assert.ok(!isProjectInstruction({ kind: 'compact-checkpoint' }))
})
