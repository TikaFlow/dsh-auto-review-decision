/**
 * 本插件共用的类型定义。
 *
 * @module dsh-auto-review-decision/types
 */

import type { ContentBlock, MessageSource, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** 一条保留历史条目所携带的来源权威性角色。 */
export type ReviewSourceRole =
    | 'user-instruction'
    | 'direct-parent-instruction'
    | 'constraint'
    | 'checkpoint'
    | 'fact'

/** 工具调用所处的执行通道。 */
export type CallMode = 'native' | 'ptc-inner'

/** 拆成单块后的一条用户角色消息。 */
export interface HistoricalUserMessage {
    readonly kind: 'user-message'
    readonly role: ReviewSourceRole
    readonly source: MessageSource
    readonly content: readonly ContentBlock[]
}

/** 一条历史工具调用记录。 */
interface HistoricalToolCall {
    readonly kind: 'tool-call'
    readonly role: 'fact'
    readonly mode: CallMode
    readonly name: string
    readonly arguments: string
}

/** 模型在发起调用前写下的说明：它声称自己要做什么。 */
export interface HistoricalAssistantClaim {
    readonly kind: 'assistant-claim'
    readonly role: 'fact'
    /** 模型说明的原文。 */
    readonly text: string
}

/** 一条被裁掉的历史缺口的占位说明 */
export interface HistoricalOmitted {
    readonly kind: 'omitted'
    readonly role: 'fact'
    /** 此处连续省略的条目数。 */
    readonly count: number
    /** 面向模型的一句话说明。 */
    readonly text: string
}

/** 保留历史中的一条记录。 */
export type HistoricalEntry =
    | HistoricalUserMessage
    | HistoricalToolCall
    | HistoricalAssistantClaim
    | HistoricalOmitted

/** 供审查者使用的一份冻结输入。 */
export interface ReviewSnapshot {
    readonly cwd: string
    /** 按会话顺序排列的保留条目，最后一条是待审调用。 */
    readonly history: readonly HistoricalEntry[]
    /** 待审工具的 schema。 */
    readonly pending: { readonly schema: ToolSchema }
}

/** 会话日志中的一条原生工具调用事件。 */
export type NativeCallEvent = Extract<SessionEvent, { type: 'tool/call' }>

/** 会话日志中的一条 PTC 内层调用起始事件。 */
type PtcStartEvent = Extract<SessionEvent, { type: 'tool/ptc-dispatch-start' }>

/** 一次核心执行事件所携带的回合与步骤标识。 */
export interface StepIdentity {
    readonly turn: number
    readonly step: number
}

/** 归属于某个步骤的一条 PTC 调用起始记录。 */
export interface ScopedPtcStart {
    readonly event: PtcStartEvent
    readonly step: StepIdentity
}
