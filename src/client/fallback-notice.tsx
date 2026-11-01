/**
 * 降级提示的浏览器半：订阅宿主推送，以宿主 Toast 呈现在 `shell.overlay` 席位。
 *
 * @module dsh-auto-review-decision/client/fallback-notice
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsHooks, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { } from '@deepseek-ai/dsh-client-ui-layout/client'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { presetName } from './preset-labels.ts'
import { NOTICE_URL } from '../shared/config.ts'

/** 一条待显示的降级提示。 */
interface FallbackNotice {
    /** 每次提示递增，用作 Toast 重挂的 key。 */
    readonly seq: number
    /** 该会话切到的权限预设名。 */
    readonly preset: string
}

/** 提示状态。 */
type FallbackNoticeState = FallbackNotice | null

/** 提示状态源与动作。 */
interface FallbackNoticeFace {
    /** 渲染器绑定的快照选择器。 */
    readonly hooks: { readonly fallbackNotice: SnapshotStore<FallbackNoticeState> }
    /** 撤销当前提示。 */
    readonly dismiss: () => void
}

/** 提示组件 props。 */
type FallbackNoticeProps = PropsLocale<'settings.autoReviewDecision'>
    & Omit<FallbackNoticeFace, 'hooks'>
    & PropsHooks<FallbackNoticeFace['hooks']>

/**
 * 渲染当前降级提示。
 * @param props - 快照选择器、撤销动作与文案。
 */
function FallbackNoticeView({ useFallbackNotice, dismiss, t }: FallbackNoticeProps) {
    const notice = useFallbackNotice(snapshot => snapshot)
    if (notice === null) return null
    return (
        <Toast
            key={notice.seq}
            text={t('fallbackNotice').replace('{preset}', presetName(notice.preset, t))}
            icon={<IconWarningOutlineRegular />}
            onDone={dismiss}
        />
    )
}

/**
 * 订阅宿主降级推送并注册提示席位。
 * @param ctx - 浏览器插件上下文。
 * @returns 释放函数。
 */
export function applyFallbackNotice(ctx: ClientContext): () => void {
    const store = createSnapshotStore<FallbackNoticeState>(null)
    let seq = 0
    // EventSource 自带重连：断线重连后继续收推送；断线期间的提示会丢失。
    const source = new EventSource(NOTICE_URL)
    source.onmessage = (event: MessageEvent<string>) => {
        let parsed: unknown
        try {
            parsed = JSON.parse(event.data)
        } catch {
            return
        }
        if (typeof parsed !== 'object' || parsed === null) return
        const preset = (parsed as { preset?: unknown }).preset
        if (typeof preset !== 'string') return
        seq += 1
        store.set({ seq, preset })
    }
    const face: FallbackNoticeFace = {
        hooks: { fallbackNotice: store },
        dismiss: () => { store.set(null) },
    }
    const stopSlot = ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'auto-review-decision.fallback',
        locale: 'settings.autoReviewDecision',
        inject: () => face,
    }, FallbackNoticeView))
    return () => {
        source.close()
        stopSlot()
    }
}
