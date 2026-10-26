/**
 * 浏览器半入口：把配置卡片挂进「插件」管理界面。
 *
 * 顶层只声明核心服务；`configForms`、`remote.credentials` 与席位注册落在子 fiber，
 * 子 fiber 卸载即级联撤销。
 *
 * @module dsh-auto-review-systemOne/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { } from '@deepseek-ai/dsh-client-locale/client'
import type { } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ComposedProps } from '@deepseek-ai/dsh-client-ui-slots'
import { Card } from './card.tsx'
import { CardController, type CardFace } from './controller.ts'
import { applyFallbackNotice } from './fallback-notice.tsx'
import { dictionaries, type CardLocaleKey } from './locale.ts'
import { CONFIG_NS, PLUGIN_NAME } from '../shared/config.ts'

/** 文案命名空间。 */
const NS = 'settings.autoReviewSystemOne'

/** 顶层依赖：仅核心服务。 */
export const inject = ['slots', 'locale']

declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** 卡片文案。 */
        'settings.autoReviewSystemOne': CardLocaleKey
    }
}

/** 卡片组件的完整 props：席位 owner props + 注入面 + 文案。 */
type CardSlotProps = ComposedProps<'plugins.bundle.config', string, never, undefined, CardFace, never, typeof NS>

/** 注册卡片。 */
export function apply(ctx: ClientContext): void {
    ctx.inject(['remote', 'remote.credentials', 'configForms'], (child) => {
        boot(child)
        child.effect(() => applyFallbackNotice(child), 'auto-review: fallback notice')
    })
}

/** 编排体：词典、控制器与两个席位注册，全部挂在子 fiber 上。 */
function boot(ctx: ClientContext): void {
    const t = ctx.locale.bind(NS)
    ctx.effect(() => ctx.locale.register(NS, dictionaries), 'auto-review: card dictionaries')
    const controller = new CardController(ctx)
    ctx.effect(() => () => { controller.dispose() }, 'auto-review: card controller')
    // `hooks` 由渲染器消费并绑定成 `useCard`，不进入组件 props。
    const { hooks, ...actions } = controller.inject()
    const face = () => ({ ...actions, hooks })
    const render = (props: CardSlotProps) => {
        if (props.view === 'summary') return t('description')
        return <Card {...props} t={t} defaultOpen />
    }
    ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: PLUGIN_NAME,
        locale: NS,
        inject: face,
    }, render)), 'auto-review: bundle config card')
    ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: `${PLUGIN_NAME}#${CONFIG_NS}`,
        locale: NS,
        inject: face,
    }, render)), 'auto-review: row config card')
}
