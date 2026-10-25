/**
 * 来源角色判定：区分浏览器提示词、项目指令、压缩检查点与直接父级指令，
 * 并识别当前会话及继承会话中由模型自造的创建提示词。
 *
 * @module dsh-auto-review-systemOne/roles
 */

import type { MessageSource, ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { HistoricalUserMessage, ReviewSourceRole } from './types.ts'

/** 浏览器准入是否能区分用户提示词与子代理的创建提示词。 */
function isBrowserPrompt(source: MessageSource): boolean {
    return source.kind === 'user'
        && typeof (source as { readonly rpcId?: unknown }).rpcId === 'string'
}

/** 该可见上下文是否为当前项目指令来源。 */
export function isProjectInstruction(source: MessageSource): boolean {
    return source.kind === 'agent-instructions'
}

/** 该来源是否为一次压缩检查点。 */
function isCheckpoint(source: MessageSource): boolean {
    const kind: string = source.kind
    return kind === 'compact-checkpoint'
}

/** 该消息是否被持久归因于子代理的直接父级。 */
function isDirectParentInstruction(source: MessageSource, parentSession: string | undefined): boolean {
    return parentSession !== undefined
        && source.kind === 'agent-message'
        && (source as { readonly senderSessionId?: unknown }).senderSessionId === parentSession
}

/** 当前会话与继承会话中已识别的创建提示词。 */
interface CreationPrompts {
    readonly own: SessionEvent['seq'] | undefined
    readonly all: ReadonlySet<SessionEvent['seq']>
}

/** 识别当前会话与继承会话中由模型自造的创建提示词。 */
export function creationPrompts(
    agent: Agent,
    events: readonly SessionEvent[],
): CreationPrompts {
    const { session } = agent
    const all = new Set<SessionEvent['seq']>()
    let passedCreationBoundary = false
    for (const event of events) {
        if (event.type === 'subagent/descriptor') {
            passedCreationBoundary = true
            continue
        }
        if (passedCreationBoundary
            && event.type === 'user/message'
            && event.data.source.kind === 'user'
            && !isBrowserPrompt(event.data.source)) {
            all.add(event.seq)
            if (session.isOwnSeq(event.seq) && session.header.origin === 'subagent' && session.header.parentSession !== undefined) {
                return { own: event.seq, all }
            }
            passedCreationBoundary = false
        }
    }
    return { own: undefined, all }
}

/** 为一条保留的文本块指定固定的指令、约束、摘要或事实角色。 */
function textRole(
    source: MessageSource,
    seq: SessionEvent['seq'],
    prompts: CreationPrompts,
    session: Session,
): ReviewSourceRole {
    if (seq === prompts.own || isDirectParentInstruction(source, session.header.parentSession)) {
        return 'direct-parent-instruction'
    }
    if (prompts.all.has(seq)) return 'fact'
    if (source.kind === 'user') {
        // 子代理未被验证的创建提示词不得取得用户级权威。
        if (prompts.own === undefined && session.header.origin === 'subagent'
            && session.header.parentSession !== undefined && session.isOwnSeq(seq)
            && !isBrowserPrompt(source)) return 'fact'
        return 'user-instruction'
    }
    if (isCheckpoint(source)) return 'checkpoint'
    return 'fact'
}

/** 把一条可见的用户角色消息拆分为带角色标注的保留块。 */
export function filteredUserEntries(
    seq: SessionEvent['seq'],
    source: MessageSource,
    content: readonly ContentBlock[],
    prompts: CreationPrompts,
    session: Session,
): HistoricalUserMessage[] {
    return content.map(block => ({
        kind: 'user-message',
        role: block.type === 'text'
            ? textRole(source, seq, prompts, session)
            : 'fact',
        source,
        content: [block],
    }))
}
