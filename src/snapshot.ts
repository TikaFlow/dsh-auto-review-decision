/**
 * 审查输入的冻结：从会话日志与待执行动作构造不可变快照。
 *
 * @module dsh-auto-review-decision/snapshot
 */

import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {
    CallMode,
    HistoricalAssistantClaim,
    HistoricalEntry,
    HistoricalToolSchema,
    NativeCallEvent,
    ReviewSnapshot,
    ScopedPtcStart,
} from './types.ts'
import {
    json,
    loggedSchema,
    parseLoggedArguments,
    sameJson,
} from './log.ts'
import { isRecord } from './shared/tools.ts'
import {
    creationPrompts,
    filteredUserEntries,
    isProjectInstruction,
} from './roles.ts'
import {
    sameStep,
    scopedCallKey,
    scopePtcStarts,
    shownSchemaKey,
    stepIdentity,
} from './steps.ts'

/** 构造描述某次调用所用工具的历史条目。 */
function toolSchemaEntry(mode: CallMode, schema: ToolSchema): HistoricalToolSchema {
    return { kind: 'tool-schema', role: 'fact', mode, name: schema.name, description: schema.description, parameters: schema.parameters }
}

/** 从可见调用与最新请求头中解析一次原生动作的 schema。 */
function nativeAction(
    exec: ToolExecution,
    headerTools: readonly ToolSchema[] | undefined,
    logged: NativeCallEvent,
): HistoricalToolSchema {
    if (logged.data.name !== exec.name
        || !sameJson(parseLoggedArguments(logged.data.arguments), exec.arguments)) {
        throw new Error('auto-review: the pending native call disagrees with its logged action')
    }
    const candidates: readonly unknown[] = Array.isArray(headerTools) ? headerTools : []
    const schemas = candidates.filter((schema): schema is Record<string, unknown> =>
        isRecord(schema) && schema['name'] === exec.name)
    const [candidate] = schemas
    if (candidate === undefined || schemas.length !== 1) {
        throw new Error('auto-review: the pending native tool schema is missing or ambiguous')
    }
    return toolSchemaEntry('native', loggedSchema(candidate, exec.name, 'native'))
}

/** 从绑定与已记录身份中解析一次 PTC 内层动作的 schema。 */
function ptcAction(
    exec: ToolExecution,
    start: ScopedPtcStart,
    visibleParentKeys: ReadonlySet<string>,
): HistoricalToolSchema {
    const { event } = start
    if (!visibleParentKeys.has(scopedCallKey(start.step, event.data.parentCallId))
        || event.data.rootCallId !== exec.rootCallId
        || event.data.name !== exec.name
        || !sameJson(event.data.arguments, exec.arguments)) {
        throw new Error('auto-review: the pending PTC call disagrees with its logged action')
    }
    if (exec.schema === undefined || exec.schema.name !== exec.name) {
        throw new Error('auto-review: the pending PTC binding schema is missing or inconsistent')
    }
    return toolSchemaEntry('ptc-inner', loggedSchema(exec.schema, exec.name, 'PTC'))
}

/** 提取待审调用所在那条消息里模型写下的说明。 */
function assistantClaim(
    content: readonly ContentBlock[],
    isCurrentMessage: boolean,
): HistoricalAssistantClaim | undefined {
    if (!isCurrentMessage) return undefined
    const text = content
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('\n')
        .trim()
    if (text === '') return undefined
    return { kind: 'assistant-claim', role: 'fact', text }
}

/**
 * 从一次会话与待执行动作冻结出审查者输入。
 * @param agent - 其持久表面与请求头为该调用提供授权的 agent。
 * @param exec - 不可变的待执行动作。
 * @param cwd - 会话当前工作目录。
 * @param shown - 该会话此前审查已展示的 schema。
 * @returns 精确的环境，以及以待审调用结尾的历史。
 */
export function snapshotAutoReview(
    agent: Agent,
    exec: ToolExecution,
    cwd: string,
    shown: ReadonlyMap<string, HistoricalToolSchema>,
): ReviewSnapshot {
    const { session } = agent
    // 审查者的风险输入是完整的动作历史：此前的原生调用与 PTC 起始事件携带了
    // 本次调用需要比对的授权与重复身份，直接父级的初始提示词则设定了委派范围。
    // 目前尚无任何投影或分页读取方暴露这些记录。
    // oxlint-disable-next-line typescript/no-deprecated -- 审查者需要完整动作历史；目前尚无投影或分页读取方。
    const events = session.snapshotEvents()
    const nodes = [...session.surface.nodes]
    const header = session.requestHeader()
    if (header === undefined) {
        throw new Error('auto-review: no complete request-header route is available')
    }

    const nativeCalls = events.filter((event): event is NativeCallEvent => event.type === 'tool/call')
    const { starts, openStep: currentStep } = scopePtcStarts(events)
    const prompts = creationPrompts(agent, events)
    const nativeByScopedId = new Map<string, NativeCallEvent[]>()
    for (const event of nativeCalls) {
        const key = scopedCallKey(stepIdentity(event.data), event.data.callId)
        const bucket = nativeByScopedId.get(key)
        if (bucket === undefined) nativeByScopedId.set(key, [event])
        else bucket.push(event)
    }
    const startsByParent = new Map<string, ScopedPtcStart[]>()
    const startsBySubCall = new Map<string, ScopedPtcStart>()
    for (const start of starts) {
        const subCallKey = scopedCallKey(start.step, start.event.data.subCallId)
        if (startsBySubCall.has(subCallKey)) {
            throw new Error('auto-review: a PTC call identity is ambiguous in the session log')
        }
        startsBySubCall.set(subCallKey, start)
        const parentKey = scopedCallKey(start.step, start.event.data.parentCallId)
        const bucket = startsByParent.get(parentKey)
        if (bucket === undefined) startsByParent.set(parentKey, [start])
        else bucket.push(start)
    }

    if (currentStep === undefined) {
        throw new Error('auto-review: the pending call has no open step in the session log')
    }
    const currentRootCalls = nativeByScopedId.get(scopedCallKey(currentStep, exec.rootCallId)) ?? []
    const currentRootCall = currentRootCalls[0]
    if (currentRootCall === undefined || currentRootCalls.length !== 1) {
        throw new Error('auto-review: the pending root call is missing or ambiguous in the session log')
    }
    const currentPtcStart = exec.parent === undefined
        ? undefined
        : startsBySubCall.get(scopedCallKey(currentStep, exec.callId))
    if (exec.parent !== undefined && currentPtcStart === undefined) {
        throw new Error('auto-review: the pending PTC call is missing or ambiguous in the session log')
    }

    const history: HistoricalEntry[] = []
    const emittedSchemas = new Set<string>()
    // 一次调用的 schema 只在首次使用它的调用之前出现一次。
    const pushCall = (
        mode: CallMode,
        key: string,
        name: string,
        rawArguments: string,
        schema = shown.get(key),
    ): void => {
        if (schema !== undefined && !emittedSchemas.has(JSON.stringify(schema))) {
            emittedSchemas.add(JSON.stringify(schema))
            history.push(schema)
        }
        history.push({ kind: 'tool-call', role: 'fact', mode, name, arguments: rawArguments })
    }
    const visibleParentKeys = new Set<string>()
    let passedCurrentRoot = false
    for (const seq of nodes) {
        // 表面节点是由本会话经过校验的折叠产出的时间索引。
        // oxlint-disable-next-line typescript/no-non-null-assertion
        const event = events[seq]!
        if (event.type === 'user/message') {
            if (event.data.source.kind === 'tool') continue
            if (isProjectInstruction(event.data.source)) {
                const content = event.data.content
                if (content.length > 0) {
                    history.push({
                        kind: 'user-message',
                        role: 'constraint',
                        source: event.data.source,
                        content,
                    })
                }
            } else {
                history.push(...filteredUserEntries(
                    event.seq,
                    event.data.source,
                    event.data.content,
                    prompts,
                    session,
                ))
            }
            continue
        }
        if (event.type !== 'assistant/message') continue
        const messageStep = stepIdentity(event.data)
        const isCurrentMessage = sameStep(messageStep, currentStep)
        let sawUnstartedSibling = false
        // 模型在发起调用前写下的说明：它解释这次调用想做什么，排在本次调用的 tool-call 之前。
        const claim = assistantClaim(event.data.message.content, isCurrentMessage)
        let claimPushed = false
        for (const block of event.data.message.content) {
            if (block.type !== 'tool-call') continue
            if (claim !== undefined && !claimPushed) {
                history.push(claim)
                claimPushed = true
            }
            const key = scopedCallKey(messageStep, block.id)
            const isCurrentRoot = isCurrentMessage && block.id === exec.rootCallId
            if (isCurrentRoot && passedCurrentRoot) {
                throw new Error('auto-review: the pending root call is ambiguous in the current surface')
            }
            const calls = nativeByScopedId.get(key) ?? []
            if (calls.length > 1) {
                throw new Error('auto-review: a native call identity is ambiguous in the session log')
            }
            const call = calls[0]
            const startsForCall = startsByParent.get(key) ?? []
            if (call === undefined) {
                if (isCurrentMessage && !passedCurrentRoot) {
                    throw new Error('auto-review: a visible call before the pending root is missing from the session log')
                }
                if (startsForCall.length > 0) {
                    throw new Error('auto-review: an unstarted visible call has logged PTC dispatches')
                }
                sawUnstartedSibling = true
                continue
            }
            if (sawUnstartedSibling) {
                throw new Error('auto-review: visible native call logs do not form a started prefix')
            }
            if (call.data.name !== block.name || call.data.arguments !== block.arguments) {
                throw new Error('auto-review: a visible tool call disagrees with its logged action')
            }
            visibleParentKeys.add(key)
            if (call !== currentRootCall || exec.parent !== undefined) {
                pushCall('native', shownSchemaKey('native', key), call.data.name, call.data.arguments)
            }
            for (const start of startsForCall) {
                if (start === currentPtcStart) continue
                const subCallKey = scopedCallKey(start.step, start.event.data.subCallId)
                pushCall('ptc-inner', shownSchemaKey('ptc-inner', subCallKey), start.event.data.name, json(start.event.data.arguments))
            }
            if (isCurrentRoot) passedCurrentRoot = true
        }
    }

    if (!passedCurrentRoot) {
        throw new Error('auto-review: the pending root call is missing from the current surface')
    }

    let pending: ReviewSnapshot['pending']
    if (currentPtcStart === undefined) {
        pending = {
            key: shownSchemaKey('native', scopedCallKey(currentStep, exec.rootCallId)),
            schema: nativeAction(exec, header.tools, currentRootCall),
        }
        pushCall('native', pending.key, exec.name, currentRootCall.data.arguments, pending.schema)
    } else {
        pending = {
            key: shownSchemaKey('ptc-inner', scopedCallKey(currentStep, exec.callId)),
            schema: ptcAction(exec, currentPtcStart, visibleParentKeys),
        }
        pushCall('ptc-inner', pending.key, exec.name, json(currentPtcStart.event.data.arguments), pending.schema)
    }
    return deepFreeze({
        cwd,
        history,
        pending,
    })
}

