/**
 * 决策协议解析：从审查者输出中严格解析出风险分级与决策，
 * 并拒绝重复成员、非法组合等一切歧义形态。
 *
 * @module dsh-auto-review-systemOne/decision
 */

import { BlockAssembler, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AutoReviewDecision } from './types.ts'

/** 统计原始顶层 JSON 对象中的成员数量。 */
function topLevelMemberCount(text: string): number {
    const syntax = text.replace(/"(?:\\.|[^"\\])*"/gs, '')
    let depth = 0
    let count = 0
    for (const char of syntax) {
        switch (char) {
            case '{':
            case '[':
                depth += 1
                break
            case '}':
            case ']':
                depth -= 1
                break
            case ':':
                if (depth === 1) count += 1
        }
    }
    return count
}

/** 解析封闭的风险/决策协议及其固定安全组合。 */
function parseDecision(text: string): AutoReviewDecision {
    const value: unknown = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('auto-review: reviewer output must be one JSON object')
    }
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    if (topLevelMemberCount(text) !== keys.length) {
        throw new Error('auto-review: reviewer output repeats a JSON member')
    }
    const risk = record['risk']
    const decision = record['decision']
    if (keys.length === 2 && decision === 'allow' && (risk === 'low' || risk === 'medium')) {
        return { risk, decision }
    }
    if (keys.length === 2 && decision === 'deny' && (risk === 'medium' || risk === 'high')) {
        return { risk, decision }
    }
    if (decision === 'deny'
        && (risk === 'medium' || risk === 'high')
        && keys.length === 3
        && Object.hasOwn(record, 'reason')
        && typeof record['reason'] === 'string') {
        return { risk, decision, reason: record['reason'] }
    }
    throw new Error('auto-review: reviewer output does not match the risk/decision protocol')
}

/** 消费零或多个推理块、一个 JSON 文本块以及一个终止停止信号。 */
export async function readDecision(stream: AsyncIterable<StreamChunk>): Promise<AutoReviewDecision> {
    const assembler = new BlockAssembler()
    let finished = false
    for await (const chunk of stream) {
        if (finished) throw new Error('auto-review: reviewer emitted data after its terminal finish')
        assembler.push(chunk)
        if (chunk.type === 'finish') {
            finished = true
            if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
                const { code, message } = chunk.reason.failure
                throw new Error(`auto-review: reviewer ended with ${chunk.reason.kind} ${code}: ${message}`)
            }
            if (chunk.reason.kind !== 'stop') {
                throw new Error(`auto-review: reviewer ended with ${chunk.reason.kind}`)
            }
        }
    }
    if (!finished) throw new Error('auto-review: reviewer emitted no terminal finish')
    const blocks = assembler.blocks()
    const final = blocks.at(-1)
    if (final?.type !== 'text' || blocks.slice(0, -1).some(block => block.type !== 'reasoning')) {
        throw new Error('auto-review: reviewer must emit zero or more reasoning blocks followed by exactly one text block')
    }
    return parseDecision(final.text)
}
