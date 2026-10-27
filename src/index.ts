/**
 * 基于 SystemOne 决策接口的授权闸门，服务于仅在当前会话生效的 Auto 权限预设。
 *
 * @module dsh-auto-review-systemOne
 */

import type { Context } from '@deepseek-ai/cordis'
import type { } from '@deepseek-ai/dsh-agent-instructions'
import type { } from '@deepseek-ai/dsh-subagent'
import type { } from '@deepseek-ai/dsh-working-directory'
import type { } from '@deepseek-ai/dsh-settings/types'
import { readReviewConfig, setConfigInput, type ConfigInput } from './config.ts'
import { applyFallback } from './fallback.ts'
import { applyLifecycle } from './lifecycle.ts'
import { installProbeRoute } from './probe.ts'

/** Cordis 插件名，供加载器诊断使用。 */
export const name = 'auto-review-systemOne'
/** Auto 可被声明前必须具备的完整宿主服务。 */
export const inject = ['settings', 'credentials', 'permissionPresets', 'sessions', 'tools', 'workingDirectory']

export { Config } from './config.ts'

/** 安装 Auto 预设与其审查闸门；应用关闭时保留会话选择。 */
export function apply(ctx: Context, config?: ConfigInput): void {
    // 接入配置项
    readReviewConfig(config)
    setConfigInput(() => config)

    // 降级设施：计数守卫、提示路由与 Auto 重选清零；卸载随本插件上下文回收
    applyFallback(ctx)

    // 连通性测试路由；不计入降级，与审查分流
    installProbeRoute(ctx)

    // 核心生命周期：注册 auto 预设，并审查工具调用
    applyLifecycle(ctx)
}
