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
    'glob',
    'grep',
    'skill',
    'list_agents',
    'job_list',
    'job_output',
    'terminal_read',
    'terminal_list',
    'schedule_list',
    'get_goal',
    'list_mcp_resources',
    'list_mcp_resource_templates',
    'read_mcp_resource',
    'ask_user_question',
    'present',
    'todo_write',
    'create_goal',
    'update_goal',
    'exit_plan_mode',
    'web_fetch',
    'web_search',
    'read',
    'read_image',
    'send_message',
    'interrupt_agent',
    'job_kill',
    'terminal_open',
    'terminal_close',
])

/** 半白名单：目标在工作区内才免审的工具名。 */
export const PATH_EXEMPT_TOOLS: ReadonlySet<string> = new Set(['write', 'edit'])

/** 半白名单：子级权限预设未升到无限制时才免审的委派工具名。 */
export const PRESET_EXEMPT_TOOLS: ReadonlySet<string> = new Set(['subagent', 'subagent_fork', 'workflow'])

/** 该参数指定子级权限预设；只有无限制的那一种会摆脱审查。 */
const PRESET_ARGUMENT = 'agent_preset'

/** 无限制预设：子级在该预设下不再继承审查闸门。 */
const UNREVIEWED_PRESET = 'danger-full-access'

/** 半白名单工具声明目标路径的参数名。 */
const PATH_ARGUMENT = 'file_path'

/** 白名单判定所需的文件系统能力（宿主 `ctx.fs` 的结构化投影）。 */
interface PathFence {
    /** 把路径解析为稳定目标；相对路径按 `opts.cwd` 解析。 */
    resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<unknown>
    /** 判断 `child` 是否就是 `parent` 或其后代，按规范化路径比较。 */
    contains(parent: unknown, child: unknown): boolean
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
    if (EXEMPT_TOOLS.has(exec.name)) return { kind: 'allow' }
    if (PRESET_EXEMPT_TOOLS.has(exec.name)) {
        const args = exec.arguments
        const preset = isRecord(args) ? args[PRESET_ARGUMENT] : undefined
        return preset === UNREVIEWED_PRESET ? undefined : { kind: 'allow' }
    }
    if (!PATH_EXEMPT_TOOLS.has(exec.name)) return undefined

    const args = exec.arguments
    const requested = isRecord(args) ? args[PATH_ARGUMENT] : undefined
    if (typeof requested !== 'string' || requested === '') return undefined
    const fs = ctx.get('fs') as PathFence | undefined
    if (fs === undefined) return undefined
    try {
        // 解析跟随符号链接：工作区内的链接指向外部时，目标不再落在根内。
        const root = await fs.resolve(cwd, { signal })
        const target = await fs.resolve(requested, { cwd, signal })
        return fs.contains(root, target) ? { kind: 'allow' } : undefined
    } catch {
        // 目标不存在或无法解析时退回审查，保持失败即不放行。
        return undefined
    }
}
