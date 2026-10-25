/**
 * 基于 LLM 的授权闸门，服务于仅在当前会话生效的 Auto 权限预设。
 * 每次原生调用与每个已启动的 PTC 内层调用都在其主体执行前被审查一次；
 * 外层 `run_code` 传输通道被刻意排除。在 `ask` 审批策略下，审查者拒绝会询问用户；
 * 在 `never` 下则为终局。
 *
 * @module dsh-auto-review-systemOne
 */

import type {} from '@deepseek-ai/dsh-working-directory'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-instructions'
import { AUTO_PRESET } from '@deepseek-ai/dsh-permission-presets'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-user-approval'
import { RUN_CODE_NAME, type PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { ShownSchemas } from './types.ts'
import { isAborted } from './log.ts'
import { classifyRisk } from './reviewer.ts'
import { askUser, denied, failed } from './verdict.ts'

/** Cordis 插件名，供加载器诊断使用。 */
export const name = 'auto-review-systemOne'
/** Auto 可被声明前必须具备的完整宿主服务。 */
export const inject = ['approval', 'llm', 'permissionPresets', 'sessions', 'tools', 'workingDirectory']

/** 安装 Auto 预设与其审查闸门；应用关闭时保留会话选择。 */
export function apply(ctx: Context): void {
    // 在该上下文销毁排空期间保留已注入的服务引用。
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
                    decision => ({ ok: true as const, decision }),
                    (error: unknown) => ({ ok: false as const, error }),
                )
                if (isAborted(lifecycle.signal)) return { kind: 'cancel' }
                if (!review.ok) return failed(exec, review.error)
                const { decision } = review
                // 权限所有者会向每个已发布会话钉入审批策略。
                if (decision.decision === 'deny' && ctx.approval.overrideOf(agent.session) === 'never') {
                    return denied(exec, decision.reason)
                }
                const downstream = await next()
                if (isAborted(lifecycle.signal)) return { kind: 'cancel' }
                if (decision.decision === 'allow' || downstream.kind !== 'allow') return downstream
                return askUser(exec, decision.reason)
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
