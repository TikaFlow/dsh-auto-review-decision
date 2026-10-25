/**
 * 基于 SystemOne 决策接口的授权闸门，服务于仅在当前会话生效的 Auto 权限预设。
 *
 * @module dsh-auto-review-systemOne
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-instructions'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-working-directory'
import { readReviewConfig, setConfigInput, type ConfigInput } from './config.ts'
import { applyLifecycle } from './lifecycle.ts'

/** Cordis 插件名，供加载器诊断使用。 */
export const name = 'auto-review-systemOne'
/** Auto 可被声明前必须具备的完整宿主服务。 */
export const inject = ['approval', 'llm', 'permissionPresets', 'sessions', 'tools', 'workingDirectory']

export { Config } from './config.ts'

/** 安装 Auto 预设与其审查闸门；应用关闭时保留会话选择。 */
export function apply(ctx: Context, config?: ConfigInput): void {
    // 接入配置项
    readReviewConfig(config)
    setConfigInput(() => config)

    // 核心生命周期：注册 auto 预设，并审查工具调用
    applyLifecycle(ctx)
}
