import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import {
    sameStep,
    scopePtcStarts,
    scopedCallKey,
    shownSchemaKey,
    stepIdentity,
} from '../src/steps.ts'

function turnStart(turn: number) {
    return { type: 'turn/start' as const, seq: SessionSeq(1), time: 0, data: { turn } }
}

function stepStart(turn: number, step: number) {
    return { type: 'step/start' as const, seq: SessionSeq(2), time: 0, data: { turn, step } }
}

function stepEnd(turn: number, step: number) {
    return { type: 'step/end' as const, seq: SessionSeq(3), time: 0, data: { turn, step } }
}

function nativeCall(turn: number, step: number, callId: string) {
    return {
        type: 'tool/call' as const,
        seq: SessionSeq(4),
        time: 0,
        data: { turn, step, callId: ToolCallId(callId), name: 'fs.read', arguments: '{}' },
    }
}

function ptcStart(subCallId: string, parentCallId = 'p1') {
    return {
        type: 'tool/ptc-dispatch-start' as const,
        seq: SessionSeq(5),
        time: 0,
        data: {
            rootCallId: ToolCallId('p1'),
            parentCallId: ToolCallId(parentCallId),
            subCallId: ToolCallId(subCallId),
            name: 'fs.read',
            arguments: {},
        },
    }
}

test('stepIdentity 复制回合与步骤标识，同输入结果稳定', () => {
    const data = { turn: 2, step: 3 }
    assert.deepEqual(stepIdentity(data), { turn: 2, step: 3 })
    assert.deepEqual(stepIdentity(data), stepIdentity(data))
    assert.ok(!sameStep(stepIdentity(data), { turn: 2, step: 4 }))
})

test('stepIdentity 对缺失字段原样复制为 undefined，不补默认值', () => {
    const identity = stepIdentity({} as Parameters<typeof stepIdentity>[0])
    assert.deepEqual(identity, { turn: undefined, step: undefined })
})

test('sameStep 只在 turn 与 step 都相同时为真', () => {
    const identity = { turn: 1, step: 0 }
    assert.ok(sameStep(identity, { turn: 1, step: 0 }))
    assert.ok(!sameStep(identity, { turn: 2, step: 0 }))
    assert.ok(!sameStep(identity, { turn: 1, step: 1 }))
})

test('scopedCallKey 同 step 同 callId 同键，callId 不同异键', () => {
    const step = { turn: 1, step: 0 }
    assert.equal(scopedCallKey(step, ToolCallId('c1')), scopedCallKey({ turn: 1, step: 0 }, ToolCallId('c1')))
    assert.ok(scopedCallKey(step, ToolCallId('c1')) !== scopedCallKey(step, ToolCallId('c2')))
})

test('scopedCallKey 同 callId 跨回合或步骤产生不同键', () => {
    const key = scopedCallKey({ turn: 1, step: 0 }, ToolCallId('c1'))
    assert.ok(key !== scopedCallKey({ turn: 2, step: 0 }, ToolCallId('c1')))
    assert.ok(key !== scopedCallKey({ turn: 1, step: 1 }, ToolCallId('c1')))
})

test('scopedCallKey 用分隔符防止数字拼接歧义', () => {
    const split = scopedCallKey({ turn: 1, step: 1 }, ToolCallId('01'))
    const joined = scopedCallKey({ turn: 1, step: 10 }, ToolCallId('1'))
    assert.ok(split !== joined)
})

test('shownSchemaKey 按模式前缀区分同一作用域键', () => {
    const key = scopedCallKey({ turn: 1, step: 0 }, ToolCallId('c1'))
    assert.ok(shownSchemaKey('native', key) !== shownSchemaKey('ptc-inner', key))
    assert.equal(shownSchemaKey('native', key), shownSchemaKey('native', key))
    assert.ok(shownSchemaKey('native', key) !== shownSchemaKey('native', `${key}x`))
})

test('scopePtcStarts 把 dispatch 归入被记录时打开的步骤并返回当前打开步骤', () => {
    const first = ptcStart('p1:ptc:1')
    const second = ptcStart('p1:ptc:2')
    const { starts, openStep } = scopePtcStarts([
        turnStart(1),
        stepStart(1, 0),
        first,
        stepEnd(1, 0),
        stepStart(1, 1),
        second,
    ])
    assert.equal(starts.length, 2)
    assert.ok(sameStep(starts[0].step, { turn: 1, step: 0 }))
    assert.equal(starts[0].event, first)
    assert.ok(sameStep(starts[1].step, { turn: 1, step: 1 }))
    assert.ok(openStep !== undefined && sameStep(openStep, { turn: 1, step: 1 }))
})

test('scopePtcStarts 跳过无关事件，工具调用不改变打开步骤', () => {
    const start = ptcStart('p1:ptc:1')
    const { starts, openStep } = scopePtcStarts([
        stepStart(1, 0),
        nativeCall(1, 0, 'p1'),
        start,
    ])
    assert.equal(starts.length, 1)
    assert.ok(sameStep(starts[0].step, { turn: 1, step: 0 }))
    assert.ok(openStep !== undefined && sameStep(openStep, { turn: 1, step: 0 }))
})

test('scopePtcStarts 对空输入返回空列表与未打开步骤', () => {
    assert.deepEqual(scopePtcStarts([]), { starts: [], openStep: undefined })
})

test('scopePtcStarts 对无归属步骤的 dispatch 抛错', () => {
    assert.throws(() => scopePtcStarts([ptcStart('p1:ptc:1')]), /has no owning step/)
    assert.throws(
        () => scopePtcStarts([stepStart(1, 0), stepEnd(1, 0), ptcStart('p1:ptc:1')]),
        /has no owning step/,
    )
})

test('scopePtcStarts 对重复 subCallId 不做歧义判定，歧义检查在快照组装层', () => {
    const { starts } = scopePtcStarts([
        stepStart(1, 0),
        ptcStart('p1:ptc:1'),
        ptcStart('p1:ptc:1'),
    ])
    assert.equal(starts.length, 2)
})
