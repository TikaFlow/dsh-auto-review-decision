/**
 * 会话日志的读取工具：JSON 处理、记录判定、schema 校验、中止状态读取。
 *
 * @module dsh-auto-review-systemOne/log
 */

import type { ToolSchema } from '@deepseek-ai/dsh-llm'

/** 返回某个不可变日志值的 JSON 文本。 */
export function json(value: unknown): string {
    const rendered = JSON.stringify(value, null, 2) as string | undefined
    /* v8 ignore next -- 已接受的会话事实与冻结快照按契约均为无损 JSON。 */
    if (rendered === undefined) throw new Error('auto-review: a required value is not JSON-serializable')
    return rendered
}

/** 复原 agent-loop 对一次原生调用原始参数的解析方式。 */
export function parseLoggedArguments(raw: string): unknown {
    if (raw === '') return {}
    try {
        return JSON.parse(raw)
    } catch {
        return raw
    }
}

/** 比较两个无损 JSON 值，且不保留别名。 */
export function sameJson(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right)
}

/** 判断一个已记录的 JSON 值是否为对象记录，而非 null 或数组。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 校验待审动作日志中必须具备的 schema 字段。 */
export function loggedSchema(
    value: { readonly description?: unknown; readonly parameters?: unknown },
    expectedName: string,
    mode: 'native' | 'PTC',
): ToolSchema {
    if (typeof value.description !== 'string' || !isRecord(value.parameters)) {
        throw new Error(`auto-review: the pending ${mode} tool schema is incomplete`)
    }
    return {
        name: expectedName,
        description: value.description,
        parameters: value.parameters,
    }
}

/** 跨 await 读取实时中止状态，避免依赖已失效的类型收窄。 */
export function isAborted(signal: AbortSignal): boolean {
    return signal.aborted
}
