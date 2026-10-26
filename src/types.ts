/**
 * 本插件共用的类型定义。
 *
 * @module dsh-auto-review-systemOne/types
 */

import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
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

/** 描述某次调用所用工具的一条 schema 记录。 */
export interface HistoricalToolSchema {
    readonly kind: 'tool-schema'
    readonly role: 'fact'
    readonly mode: CallMode
    readonly name: string
    readonly description: string
    readonly parameters: Record<string, unknown>
}

/** 保留历史中的一条记录。 */
export type HistoricalEntry = HistoricalUserMessage | HistoricalToolCall | HistoricalToolSchema

/**
 * 同一会话此前审查已展示过的 schema，按“模式 + 作用域调用键”索引。
 * 后续审查会在同一历史位置重复它，使每次审查的消息是上一次的前缀扩展。
 */
export type ShownSchemas = Map<string, HistoricalToolSchema>

/** 供审查者使用的一份冻结输入。 */
export interface ReviewSnapshot {
    readonly cwd: string
    /** 按会话顺序排列的保留条目，最后一条是待审调用。 */
    readonly history: readonly HistoricalEntry[]
    /** 待审调用的“模式限定作用域键”及其 schema。 */
    readonly pending: { readonly key: string; readonly schema: HistoricalToolSchema }
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
