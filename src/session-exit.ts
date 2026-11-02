/**
 * 会话退出去向：把仍处于 Auto 的会话切到指定权限预设。
 *
 * @module dsh-auto-review-decision/session-exit
 */

import type { Context } from '@deepseek-ai/cordis'
import { AUTO_PRESET } from '@deepseek-ai/dsh-permission-presets'
import { SYSTEM_TARGET } from './shared/config.ts'

/**
 * 解析退出去向：`system` 实时读取宿主的默认新会话预设，用户当前设成什么就用什么。
 */
export function resolveExitTarget(ctx: Context, target: string): string {
    return target === SYSTEM_TARGET ? ctx.permissionPresets.defaultPreset : target
}

/** 把所有仍处于 Auto 的会话切到指定预设。插件卸载与连续失败降级共用。 */
export function exitAutoSessions(ctx: Context, target: string): void {
    const resolved = resolveExitTarget(ctx, target)
    const permissionPresets = ctx.permissionPresets
    for (const session of ctx.sessions.list()) {
        if (permissionPresets.current(session) !== AUTO_PRESET) continue
        permissionPresets.set(session, resolved)
    }
}
