/**
 * 内置白名单：免于决策模型审查的调用。
 *
 * @module dsh-auto-review-systemOne/whitelist
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ReviewVerdict } from './questions.ts'
import { isRecord } from './shared/tools.ts'

/** 完全免审的工具名。 */
export const EXEMPT_TOOLS: ReadonlySet<string> = new Set([
    'ask_user_question',
    'create_goal',
    'exit_plan_mode',
    'get_goal',
    'glob',
    'grep',
    'interrupt_agent',
    'job_kill',
    'job_list',
    'job_output',
    'list_agents',
    'list_mcp_resource_templates',
    'list_mcp_resources',
    'list_subagent_models',
    'plugin_manager',
    'present',
    'read',
    'read_image',
    'read_mcp_resource',
    'schedule_list',
    'send_message',
    'skill',
    'terminal_close',
    'terminal_list',
    'terminal_open',
    'terminal_read',
    'todo_write',
    'update_goal',
    'web_fetch',
    'web_search',
])

/** 白名单判定所需的文件系统能力（宿主 `ctx.fs` 的结构化投影）。 */
interface PathFence {
    /** 把路径解析为稳定目标；相对路径按 `opts.cwd` 解析。 */
    resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<unknown>
    /** 判断 `child` 是否就是 `parent` 或其后代，按规范化路径比较。 */
    contains(parent: unknown, child: unknown): boolean
}

/** 取一个字符串参数 */
function stringArg(exec: ToolExecution, key: string): string | undefined {
    const value = isRecord(exec.arguments) ? exec.arguments[key] : undefined
    return typeof value === 'string' ? value : undefined
}

interface Validator {
    (ctx: Context, exec: ToolExecution, cwd: string, signal: AbortSignal): Promise<boolean>
}

const pathValidator: Validator = async (ctx, exec, cwd, signal) => {
    const requested = stringArg(exec, 'file_path')
    if (!requested) return false
    const fs = ctx.get('fs') as PathFence | undefined
    if (!fs) return false
    try {
        // 解析跟随符号链接
        const root = await fs.resolve(cwd, { signal })
        const target = await fs.resolve(requested, { cwd, signal })
        if (fs.contains(root, target)) return true
    } catch {
    }
    return false
}

const cdValidator: Validator = async (_ctx, exec) => {
    return !stringArg(exec, 'cd')
}

const subagentValidator: Validator = async (_ctx, exec) => {
    return stringArg(exec, 'agent_preset') !== 'danger-full-access'
}

const halfExemptDict: Record<string, Validator> = {
    edit: pathValidator,
    write: pathValidator,
    working_directory: cdValidator,
    subagent_fork: subagentValidator,
    subagent: subagentValidator,
    workflow: subagentValidator,
}

/**
 * 判定一次调用是否免审。
 * @param cwd - 会话当前工作目录，即工作区边界。
 * @returns 免审结论；`undefined` 表示仍需送审。
 */
export async function whitelistVerdict(
    ctx: Context,
    exec: ToolExecution,
    cwd: string,
    signal: AbortSignal,
): Promise<ReviewVerdict | undefined> {
    // if (用户白名单.has(exec.name)) return { kind: 'allow' } // TODO
    if (EXEMPT_TOOLS.has(exec.name)) return { kind: 'allow' }

    const validator = halfExemptDict[exec.name]
    if (validator && await validator(ctx, exec, cwd, signal)) return { kind: 'allow' }
}
