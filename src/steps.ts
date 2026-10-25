/**
 * 回合与步骤身份：作用域键构造、步骤归属、PTC 起始事件归位。
 *
 * @module dsh-auto-review-systemOne/steps
 */

import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { CallMode, ScopedPtcStart, StepIdentity } from './types.ts'

/** 复制一次核心执行事件所携带的回合与步骤标识。 */
export function stepIdentity(data: { readonly turn: number; readonly step: number }): StepIdentity {
    return { turn: data.turn, step: data.step }
}

/** 比较两个回合与步骤身份是否相同。 */
export function sameStep(left: StepIdentity, right: StepIdentity): boolean {
    return left.turn === right.turn && left.step === right.step
}

/** 在拥有该生命周期的步骤内为一次调用 id 生成键。 */
export function scopedCallKey(step: StepIdentity, callId: ToolCallId): string {
    return `${step.turn}\0${step.step}\0${callId}`
}

/** 按模式与作用域调用键生成已展示 schema 的键。 */
export function shownSchemaKey(mode: CallMode, scopedKey: string): string {
    return `${mode}\0${scopedKey}`
}

/** 把每条 PTC 起始事件归入其被记录时处于打开状态的步骤。 */
export function scopePtcStarts(events: readonly SessionEvent[]): {
    readonly starts: readonly ScopedPtcStart[]
    readonly openStep: StepIdentity | undefined
} {
    const starts: ScopedPtcStart[] = []
    let openStep: StepIdentity | undefined
    for (const event of events) {
        if (event.type === 'turn/start' || event.type === 'turn/end') {
            openStep = undefined
            continue
        }
        if (event.type === 'step/start') {
            openStep = stepIdentity(event.data)
            continue
        }
        if (event.type === 'step/end') {
            openStep = undefined
            continue
        }
        if (event.type !== 'tool/ptc-dispatch-start') continue
        if (openStep === undefined) {
            throw new Error('auto-review: a PTC call has no owning step in the session log')
        }
        starts.push({ event, step: openStep })
    }
    return { starts, openStep }
}
