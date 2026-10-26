/**
 * 会话退出去向：把仍处于 Auto 的会话切到指定权限预设。
 *
 * @module dsh-auto-review-systemOne/session-exit
 */

import type { Context } from '@deepseek-ai/cordis'
import { AUTO_PRESET } from '@deepseek-ai/dsh-permission-presets'

/** 把所有仍处于 Auto 的会话切到指定预设。插件卸载与连续失败降级共用。 */
export function exitAutoSessions(ctx: Context, target: string): void {
    const permissionPresets = ctx.permissionPresets
    for (const session of ctx.sessions.list()) {
        if (permissionPresets.current(session) !== AUTO_PRESET) continue
        permissionPresets.set(session, target)
    }
}
