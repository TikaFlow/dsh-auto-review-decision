import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { DEFAULT_CONFIG, FALLBACK_FAILURE_THRESHOLD, SYSTEM_TARGET } from '../src/shared/config.ts'
import { readReviewConfig, setConfigInput } from '../src/config.ts'
import { applyFallback, updateState } from '../src/stats.ts'
import { exitAutoSessions, resolveExitTarget } from '../src/session-exit.ts'

/** 可变的宿主默认预设引用，供断言实时读取语义。 */
function mutableDefault(value: string): { current: string } {
    return { current: value }
}

/** 构造最小宿主上下文桩：一个 Auto 会话、一个非 Auto 会话，记录切换去向。 */
function stubCtx(defaults: { readonly current: string }): {
    readonly ctx: Context
    readonly switched: { readonly session: unknown; readonly preset: string }[]
    readonly autoSession: unknown
} {
    const autoSession = { id: 'auto' }
    const otherSession = { id: 'other' }
    const switched: { session: unknown; preset: string }[] = []
    const ctx = {
        permissionPresets: {
            get defaultPreset(): string {
                return defaults.current
            },
            current: (session: unknown): string => (session === autoSession ? 'auto' : 'read-only'),
            set: (session: unknown, preset: string): void => {
                switched.push({ session, preset })
            },
        },
        sessions: { list: (): unknown[] => [autoSession, otherSession] },
    }
    return { ctx: ctx as unknown as Context, switched, autoSession }
}

test('缺省配置的两个去向默认为 system', () => {
    assert.equal(DEFAULT_CONFIG.onSessionReset, 'system')
    assert.equal(DEFAULT_CONFIG.onApiUnavailable, 'system')
})

test('readReviewConfig 未设置去向时落 system', () => {
    const parsed = readReviewConfig(undefined)
    assert.equal(parsed.values.onSessionReset, 'system')
    assert.equal(parsed.values.onApiUnavailable, 'system')
    const withEmpty = readReviewConfig({})
    assert.equal(withEmpty.values.onSessionReset, 'system')
    assert.equal(withEmpty.values.onApiUnavailable, 'system')
})

test('readReviewConfig 接受 system 与原有三个预设，拒绝其余取值', () => {
    assert.equal(readReviewConfig({ onApiUnavailable: 'system' }).values.onApiUnavailable, 'system')
    assert.equal(readReviewConfig({ onSessionReset: 'read-only' }).values.onSessionReset, 'read-only')
    assert.equal(readReviewConfig({ onSessionReset: 'workspace-write' }).values.onSessionReset, 'workspace-write')
    assert.equal(readReviewConfig({ onSessionReset: 'danger-full-access' }).values.onSessionReset, 'danger-full-access')
    assert.throws(() => readReviewConfig({ onSessionReset: 'custom' }), /onSessionReset/)
    assert.throws(() => readReviewConfig({ onApiUnavailable: 42 }), /onApiUnavailable/)
})

test('resolveExitTarget 非 system 原样返回', () => {
    const { ctx } = stubCtx(mutableDefault('workspace-write'))
    assert.equal(resolveExitTarget(ctx, 'read-only'), 'read-only')
    assert.equal(resolveExitTarget(ctx, 'danger-full-access'), 'danger-full-access')
})

test('resolveExitTarget 对 system 实时读取宿主默认预设', () => {
    const defaults = mutableDefault('workspace-write')
    const { ctx } = stubCtx(defaults)
    assert.equal(resolveExitTarget(ctx, SYSTEM_TARGET), 'workspace-write')
    // 选择时不快照：宿主默认变化后，下一次解析跟随新值。
    defaults.current = 'read-only'
    assert.equal(resolveExitTarget(ctx, SYSTEM_TARGET), 'read-only')
})

test('exitAutoSessions 只切走 Auto 会话，system 解析为当时默认预设', () => {
    const defaults = mutableDefault('workspace-write')
    const { ctx, switched, autoSession } = stubCtx(defaults)
    exitAutoSessions(ctx, SYSTEM_TARGET)
    assert.equal(switched.length, 1)
    assert.equal(switched[0].session, autoSession)
    assert.equal(switched[0].preset, 'workspace-write')
})

test('降级动作每次实时读取 system 指向的默认预设', () => {
    setConfigInput(() => ({ onApiUnavailable: 'system', notifyOnFallback: true }))
    try {
        const defaults = mutableDefault('workspace-write')
        const autoSession = { id: 'auto' }
        const otherSession = { id: 'other' }
        const switched: { readonly session: unknown; readonly preset: string }[] = []
        const ctx = new Context()
        ctx.provide('sessions', { list: () => [autoSession, otherSession] })
        ctx.provide('permissionPresets', {
            get defaultPreset(): string { return defaults.current },
            current: (session: unknown): string => (session === autoSession ? 'auto' : 'read-only'),
            set: (session: unknown, preset: string): void => { switched.push({ session, preset }) },
        })
        applyFallback(ctx)

        for (let index = 0; index < FALLBACK_FAILURE_THRESHOLD; index++) updateState('failed')
        assert.deepEqual(switched, [{ session: autoSession, preset: 'workspace-write' }])

        // 重置统计模拟热重载；宿主默认已改，再次降级用新值。
        applyFallback(ctx)
        defaults.current = 'danger-full-access'
        for (let index = 0; index < FALLBACK_FAILURE_THRESHOLD; index++) updateState('failed')
        assert.deepEqual(switched.at(-1), { session: autoSession, preset: 'danger-full-access' })
    } finally {
        setConfigInput(() => undefined)
    }
})
