/**
 * 审查闸门的生命周期：Auto 预设贡献、前置审查接线、卸载时的会话去向与在途请求排空。
 *
 * @module dsh-auto-review-systemOne/lifecycle
 */

import { FiberState, type Context } from '@deepseek-ai/cordis'
import { AUTO_PRESET } from '@deepseek-ai/dsh-permission-presets'
import type { Session } from '@deepseek-ai/dsh-session'
import { RUN_CODE_NAME, type PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { ShownSchemas } from './types.ts'
import { isAborted } from './log.ts'
import { classifyRisk } from './reviewer.ts'
import { askUser, denied, failed } from './verdict.ts'

/** 安装 Auto 预设与其审查闸门；应用关闭时保留会话选择。 */
export function applyLifecycle(ctx: Context): void {
    // 保留已注入的服务引用，供上下文销毁排空期间使用。
    const permissionPresets = ctx.permissionPresets
    let accepting = true
    const active = new Set<Promise<void>>()
    const shownBySession = new WeakMap<Session, ShownSchemas>()
    const lifecycle = new AbortController()

    ctx.effect(function* () {
        const stopListener = ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
            const agent = exec.agent
            if (agent === undefined || (exec.parent === undefined && exec.name === RUN_CODE_NAME)) {
                return next()
            }
            if (permissionPresets.current(agent.session) !== AUTO_PRESET) {
                return next()
            }
            if (!accepting || lifecycle.signal.aborted) {
                return { kind: 'cancel' }
            }

            const completed = Promise.withResolvers<void>()
            active.add(completed.promise)
            try {
                const signal = AbortSignal.any([exec.signal, lifecycle.signal])
                let shown = shownBySession.get(agent.session)
                if (shown === undefined) {
                    shown = new Map()
                    shownBySession.set(agent.session, shown)
                }
                const review = await classifyRisk(ctx, agent, exec, signal, shown).then(
                    verdict => ({ ok: true as const, verdict }),
                    (error: unknown) => ({ ok: false as const, error }),
                )
                if (isAborted(lifecycle.signal)) return { kind: 'cancel' }
                if (!review.ok) return failed(exec, review.error)
                const { verdict } = review
                // 结论自带落地方式：deny 是原则问题，不询问用户，也不执行调用体。
                if (verdict.kind === 'deny') return denied(exec, verdict.reason)
                const downstream = await next()
                if (isAborted(lifecycle.signal)) return { kind: 'cancel' }
                if (verdict.kind === 'allow' || downstream.kind !== 'allow') return downstream
                return askUser(exec, verdict.reason)
            } finally {
                active.delete(completed.promise)
                completed.resolve()
            }
        }, { prepend: true })
        yield stopListener
        const stopContribution = permissionPresets.registerAuto(() => {
            if (!accepting) throw new Error('auto-review: integration is closing')
        })
        yield stopContribution
        yield async () => {
            accepting = false
            try {
                // 根上下文卸载先于子级清理开始；只有插件被运行时移除才会改变会话策略。
                if (ctx.root.fiber.state === FiberState.ACTIVE) {
                    for (const session of ctx.sessions.list()) {
                        if (permissionPresets.current(session) !== AUTO_PRESET) continue
                        permissionPresets.set(session, 'danger-full-access')
                    }
                }
            } finally {
                lifecycle.abort(new Error('auto-review integration disposed'))
                await Promise.allSettled([...active])
            }
        }
    }, 'auto-review lifecycle')
}
