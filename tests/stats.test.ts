import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { observe, resetBudget } from '../src/budget.ts'
import { applyFallback, resetFallbackState, reviewStats, updateState } from '../src/stats.ts'
import { FALLBACK_FAILURE_THRESHOLD } from '../src/shared/config.ts'
import {
    formatStatTime,
    formatStatValue,
    parseStats,
} from '../src/shared/stats.ts'

/** 与 reviewer 内部的签名拼接方式一致，用于校准当前因子。 */
const SIGNATURE = 'http://review.test|false|review-model'

/** 复位统计与预算账本：applyFallback 是唯一的统计安装入口，换一个新的宿主上下文即归零。 */
function reset(): void {
    const ctx = new Context()
    ctx.provide('sessions', { list: () => [] as unknown[] })
    ctx.provide('permissionPresets', {
        current: () => 'read-only',
        set: () => {},
        get defaultPreset(): string { return 'read-only' },
    })
    applyFallback(ctx)
    resetBudget()
}

/** 连续记若干次失败的尝试：每个 attempt 都带一个 failed 结局。 */
function fail(times: number): void {
    for (let index = 0; index < times; index++) {
        updateState('attempt')
        updateState('failed', {})
    }
}

test('没有审查时各项为零，四条等式成立且不出现 NaN', () => {
    reset()
    const stats = reviewStats()
    assert.equal(stats.reviewCount, 0)
    assert.equal(stats.modelReviews, 0)
    assert.equal(stats.localReviews, 0)
    assert.equal(stats.configErrors, 0)
    assert.equal(stats.requests, 0)
    assert.equal(stats.retries, 0)
    assert.equal(stats.succeeded + stats.failed + stats.rateLimited, 0)
    assert.equal(stats.consecutiveFailures, 0)
    assert.equal(stats.degraded, false)
    assert.equal(stats.factorFallbacks, 0)
    assert.equal(stats.averageMs, 0)
    assert.ok(Number.isFinite(stats.averageMs))
    assert.equal(stats.lastSuccessAt, undefined)
    assert.equal(stats.lastFailureAt, undefined)
    assert.equal(stats.lastFallbackAt, undefined)
    assert.equal(stats.factor, undefined)
    assert.equal(stats.lastBytes, undefined)
    assert.equal(stats.lastTokens, undefined)
})

test('面板空账本：累计类全为 0，最近类与时间戳全为 --，不出现 NaN', () => {
    reset()
    const stats = reviewStats()
    const unit = '字节'
    const now = Date.now()
    const counts = [
        stats.reviewCount,
        stats.localReviews,
        stats.modelReviews,
        stats.configErrors,
        stats.requests,
        stats.retries,
        stats.succeeded,
        stats.failed,
        stats.rateLimited,
        stats.denied,
        stats.asked,
        stats.consecutiveFailures,
        stats.fallbacks,
        stats.factorFallbacks,
        stats.calibrations,
        stats.inputTokens,
    ]
    for (const value of counts) assert.equal(formatStatValue(value), '0')
    assert.equal(formatStatValue(stats.sentBytes, { unit }), '0 字节')
    assert.equal(formatStatValue(stats.totalMs, { unit: 'ms', fixed: 2 }), '0 ms')
    assert.equal(formatStatValue(stats.averageMs, { unit: 'ms', fixed: 2 }), '0 ms')

    const recent = [
        formatStatValue(stats.lastBytes, { unit, placeholder: '--' }),
        formatStatValue(stats.lastTokens, { placeholder: '--' }),
        formatStatValue(stats.lastFactor, { fixed: 2, placeholder: '--' }),
        formatStatValue(stats.factor, { fixed: 2, placeholder: '--' }),
        formatStatValue(stats.lastFallbackAt, { placeholder: '--', now }),
        formatStatValue(stats.lastSuccessAt, { placeholder: '--', now }),
        formatStatValue(stats.lastFailureAt, { placeholder: '--', now }),
    ]
    for (const value of recent) assert.equal(value, '--')

    // 统计不可达（字段整体缺省）时也遵守同一规则：累计类补 0，最近类仍为占位符。
    assert.equal(formatStatValue(undefined), '0')
    assert.equal(formatStatValue(undefined, { unit }), '0 字节')
    assert.equal(formatStatValue(undefined, { unit: 'ms', fixed: 2 }), '0 ms')
    assert.equal(formatStatValue(undefined, { placeholder: '--' }), '--')
    assert.equal(formatStatValue(undefined, { unit, placeholder: '--' }), '--')
    assert.equal(formatStatValue(undefined, { fixed: 2, placeholder: '--' }), '--')
    assert.equal(formatStatValue(undefined, { placeholder: '--', now }), '--')

    const rendered = [
        ...counts.map(value => formatStatValue(value)),
        formatStatValue(undefined, { unit }),
        formatStatValue(undefined, { unit: 'ms', fixed: 2 }),
        ...recent,
    ]
    for (const value of rendered) {
        assert.ok(value !== '', '出现空字符串')
        assert.ok(!value.includes('NaN'), `出现 NaN：${value}`)
        assert.ok(!value.includes('undefined'), `出现 undefined：${value}`)
        assert.ok(!value.startsWith(' '), `出现半截单位：${value}`)
    }
})

test('审查次数 = 本地审查 + 模型审查；模型审查 = 配置错误 + 发起请求的模型审查', () => {
    reset()
    updateState('review')
    updateState('localReview')
    updateState('review')
    updateState('modelReview')
    updateState('configError')
    updateState('review')
    updateState('modelReview')
    updateState('configError')
    for (const bytes of [100, 200, 300, 400]) {
        updateState('review')
        updateState('modelReview')
        updateState('attempt', { bodyBytes: bytes })
        const outcome = ['succeeded', 'succeeded', 'failed', 'rateLimited'][bytes / 100 - 1] as
            'succeeded' | 'failed' | 'rateLimited'
        updateState(outcome, { durationMs: bytes / 10, bodyBytes: bytes })
    }
    const stats = reviewStats()

    assert.equal(stats.reviewCount, 7)
    assert.equal(stats.localReviews, 1)
    assert.equal(stats.modelReviews, 6)
    assert.equal(stats.configErrors, 2)
    assert.equal(stats.requests, 4)
    assert.equal(stats.retries, 0)
    assert.equal(stats.succeeded, 2)
    assert.equal(stats.failed, 1)
    assert.equal(stats.rateLimited, 1)
    assert.equal(stats.reviewCount, stats.localReviews + stats.modelReviews)
    assert.equal(stats.modelReviews, stats.configErrors + stats.requests - stats.retries)
    assert.equal(stats.requests, stats.succeeded + stats.failed + stats.rateLimited)
    assert.equal(stats.retries, stats.requests - (stats.modelReviews - stats.configErrors))
})

test('重试 2 次的审查 = 模型审查 +1、请求 +3、重试 +2', () => {
    reset()
    updateState('review')
    updateState('modelReview')
    updateState('attempt', { bodyBytes: 800 })
    updateState('rateLimited', { bodyBytes: 800, durationMs: 10 })
    updateState('attempt', { bodyBytes: 800, retry: true })
    updateState('rateLimited', { bodyBytes: 800, durationMs: 20 })
    updateState('attempt', { bodyBytes: 800, retry: true })
    updateState('succeeded', { bodyBytes: 800, durationMs: 50, inputTokens: 400 })
    const stats = reviewStats()
    assert.equal(stats.modelReviews, 1)
    assert.equal(stats.requests, 3)
    assert.equal(stats.retries, 2)
    assert.equal(stats.succeeded, 1)
    assert.equal(stats.rateLimited, 2)
    assert.equal(stats.requests, stats.succeeded + stats.failed + stats.rateLimited)
    assert.equal(stats.modelReviews, stats.configErrors + stats.requests - stats.retries)
    assert.equal(stats.sentBytes, 2400)
    assert.equal(stats.lastBytes, 800)
    assert.equal(stats.lastTokens, 400)
    assert.equal(stats.lastFactor, 2)
})

test('每个 attempt 都有且只有一个结局', () => {
    reset()
    updateState('review')
    updateState('modelReview')
    updateState('attempt', { bodyBytes: 100 })
    updateState('rateLimited', { bodyBytes: 100 })
    updateState('attempt', { bodyBytes: 100, retry: true })
    updateState('failed', { bodyBytes: 100 })
    updateState('attempt', { bodyBytes: 100, retry: true })
    updateState('succeeded', { bodyBytes: 100 })
    const stats = reviewStats()
    assert.equal(stats.requests, 3)
    assert.equal(stats.requests, stats.succeeded + stats.failed + stats.rateLimited)
    assert.equal(stats.retries, 2)
    assert.equal(stats.modelReviews, 1)
})

test('配置错误使模型审查次数加一，请求次数与本地审查不变', () => {
    reset()
    updateState('review')
    updateState('localReview')
    const before = reviewStats()
    updateState('review')
    updateState('modelReview')
    updateState('configError')
    const after = reviewStats()
    assert.equal(after.configErrors, 1)
    assert.equal(after.modelReviews, before.modelReviews + 1)
    assert.equal(after.reviewCount, before.reviewCount + 1)
    assert.equal(after.requests, before.requests)
    assert.equal(after.localReviews, before.localReviews)
    assert.equal(after.modelReviews, after.configErrors + after.requests - after.retries)
    assert.equal(after.reviewCount, after.localReviews + after.modelReviews)
})

test('本地审查只增加本地审查与审查次数，不进入模型审查', () => {
    reset()
    updateState('review')
    updateState('localReview')
    const stats = reviewStats()
    assert.equal(stats.localReviews, 1)
    assert.equal(stats.modelReviews, 0)
    assert.equal(stats.reviewCount, 1)
    assert.equal(stats.requests, 0)
})

test('成功、失败与 429 分别成桶，字节、耗时累计', () => {
    reset()
    updateState('attempt', { bodyBytes: 1000 })
    updateState('succeeded', { durationMs: 100, bodyBytes: 1000, inputTokens: 500 })
    updateState('attempt', { bodyBytes: 2000 })
    updateState('failed', { durationMs: 300, bodyBytes: 2000 })
    updateState('attempt', { bodyBytes: 2000 })
    updateState('rateLimited', { durationMs: 500, bodyBytes: 2000 })
    const stats = reviewStats()
    assert.equal(stats.requests, 3)
    assert.equal(stats.succeeded, 1)
    assert.equal(stats.failed, 1)
    assert.equal(stats.rateLimited, 1)
    assert.equal(stats.retries, 0)
    assert.equal(stats.sentBytes, 5000)
    assert.equal(stats.inputTokens, 500)
    assert.equal(stats.totalMs, 900)
    assert.equal(stats.averageMs, 300)
})

test('最近一次记录取最后一次尝试；非成功请求不保留 token 与单次因子', () => {
    reset()
    updateState('attempt', { bodyBytes: 800 })
    updateState('succeeded', { durationMs: 50, bodyBytes: 800, inputTokens: 400 })
    let stats = reviewStats()
    assert.equal(stats.lastBytes, 800)
    assert.equal(stats.lastTokens, 400)
    assert.equal(stats.lastFactor, 2)

    updateState('attempt', { bodyBytes: 1200 })
    updateState('rateLimited', { durationMs: 90, bodyBytes: 1200 })
    stats = reviewStats()
    assert.equal(stats.lastBytes, 1200)
    assert.equal(stats.lastTokens, undefined)
    assert.equal(stats.lastFactor, undefined)
})

test('成功响应缺少合法 token 时不入 token 累计', () => {
    reset()
    updateState('attempt', { bodyBytes: 500 })
    updateState('succeeded', { durationMs: 10, bodyBytes: 500 })
    updateState('attempt', { bodyBytes: 500 })
    updateState('succeeded', { durationMs: 10, bodyBytes: 500, inputTokens: Number.NaN })
    const stats = reviewStats()
    assert.equal(stats.inputTokens, 0)
    assert.equal(stats.lastTokens, undefined)
})

test('因子校准次数单独累计', () => {
    reset()
    updateState('attempt', { bodyBytes: 100 })
    updateState('succeeded', { durationMs: 10, bodyBytes: 100, inputTokens: 50 })
    updateState('calibration')
    assert.equal(reviewStats().calibrations, 1)
})

test('连续失败只在协议失败时累加，成功与 429 清零，中止保持原值', () => {
    reset()
    fail(1)
    assert.equal(reviewStats().consecutiveFailures, 1)
    fail(1)
    assert.equal(reviewStats().consecutiveFailures, 2)
    updateState('succeeded', {})
    assert.equal(reviewStats().consecutiveFailures, 0)
    fail(1)
    assert.equal(reviewStats().consecutiveFailures, 1)
    updateState('rateLimited', {})
    assert.equal(reviewStats().consecutiveFailures, 0)
    fail(1)
    updateState('failed', { aborted: true })
    assert.equal(reviewStats().consecutiveFailures, 1)
})

test('连续失败恰好在第 10 次触发一次降级，之后同一装载内不再重复', () => {
    reset()
    assert.equal(reviewStats().degraded, false)
    fail(FALLBACK_FAILURE_THRESHOLD - 1)
    let stats = reviewStats()
    assert.equal(stats.consecutiveFailures, FALLBACK_FAILURE_THRESHOLD - 1)
    assert.equal(stats.fallbacks, 0)
    assert.equal(stats.degraded, false)

    fail(1)
    stats = reviewStats()
    assert.equal(stats.consecutiveFailures, FALLBACK_FAILURE_THRESHOLD)
    assert.equal(stats.fallbacks, 1)
    assert.equal(stats.degraded, true)
    assert.ok(stats.lastFallbackAt !== undefined)

    fail(5)
    stats = reviewStats()
    assert.equal(stats.consecutiveFailures, FALLBACK_FAILURE_THRESHOLD + 5)
    assert.equal(stats.fallbacks, 1)
    assert.equal(stats.degraded, true)
})

test('每次降级各计一次：复位降级标记后再次触发，累计继续增加', () => {
    reset()
    const before = Date.now()
    fail(FALLBACK_FAILURE_THRESHOLD)
    let stats = reviewStats()
    assert.equal(stats.fallbacks, 1)
    assert.ok(stats.lastFallbackAt !== undefined)
    assert.ok(stats.lastFallbackAt >= before && stats.lastFallbackAt <= Date.now())

    // 重选 Auto 只清连续失败与降级标记，累计次数保留。
    resetFallbackState()
    fail(FALLBACK_FAILURE_THRESHOLD)
    stats = reviewStats()
    assert.equal(stats.fallbacks, 2)
    assert.equal(stats.degraded, true)
    assert.ok(stats.lastFallbackAt !== undefined)
})

test('因子回退事件按次累计，因子不变化也照计', () => {
    reset()
    assert.equal(reviewStats().factorFallbacks, 0)
    for (let index = 0; index < 4; index++) updateState('factorFallback')
    assert.equal(reviewStats().factorFallbacks, 4)
})

test('复位统计即回到未降级，并允许再次触发降级', () => {
    reset()
    fail(FALLBACK_FAILURE_THRESHOLD)
    assert.equal(reviewStats().degraded, true)
    assert.equal(reviewStats().fallbacks, 1)

    reset()
    let stats = reviewStats()
    assert.equal(stats.degraded, false)
    assert.equal(stats.fallbacks, 0)

    fail(FALLBACK_FAILURE_THRESHOLD)
    stats = reviewStats()
    assert.equal(stats.degraded, true)
    assert.equal(stats.fallbacks, 1)
})

test('拒绝与询问分别计数，放行不额外计数', () => {
    reset()
    updateState('verdict', { verdict: 'deny' })
    updateState('verdict', { verdict: 'ask' })
    updateState('verdict', { verdict: 'allow' })
    updateState('verdict', { verdict: 'deny' })
    const stats = reviewStats()
    assert.equal(stats.denied, 2)
    assert.equal(stats.asked, 1)
})

test('成功、失败/429 与降级时间戳在计数处同步更新', () => {
    reset()
    let stats = reviewStats()
    assert.equal(stats.lastSuccessAt, undefined)
    assert.equal(stats.lastFailureAt, undefined)
    assert.equal(stats.lastFallbackAt, undefined)

    const beforeSuccess = Date.now()
    updateState('attempt', { bodyBytes: 100 })
    updateState('succeeded', { durationMs: 10, bodyBytes: 100 })
    stats = reviewStats()
    assert.ok(stats.lastSuccessAt !== undefined)
    assert.ok(stats.lastSuccessAt >= beforeSuccess && stats.lastSuccessAt <= Date.now())
    assert.equal(stats.lastFailureAt, undefined)

    const beforeFailure = Date.now()
    updateState('attempt', { bodyBytes: 100 })
    updateState('failed', { durationMs: 10, bodyBytes: 100 })
    stats = reviewStats()
    assert.ok(stats.lastFailureAt !== undefined)
    assert.ok(stats.lastFailureAt >= beforeFailure && stats.lastFailureAt <= Date.now())
    assert.ok(stats.lastSuccessAt !== undefined && stats.lastSuccessAt <= stats.lastFailureAt)

    updateState('attempt', { bodyBytes: 100 })
    updateState('rateLimited', { durationMs: 10, bodyBytes: 100 })
    const latestFailure = reviewStats().lastFailureAt
    assert.ok(latestFailure !== undefined && latestFailure >= stats.lastFailureAt!)

    reset()
    const beforeFallback = Date.now()
    fail(FALLBACK_FAILURE_THRESHOLD)
    const after = reviewStats()
    assert.equal(after.fallbacks, 1)
    assert.ok(after.lastFallbackAt !== undefined)
    assert.ok(after.lastFallbackAt >= beforeFallback && after.lastFallbackAt <= Date.now())
})

test('当前因子由 factorChange 事件更新，未上报时缺省', () => {
    reset()
    assert.equal(reviewStats().factor, undefined)
    const factor = observe(SIGNATURE, 1000, 500)
    assert.equal(factor, 2)
    assert.equal(reviewStats().factor, undefined)
    updateState('factorChange', { factor })
    assert.equal(reviewStats().factor, 2)
})

test('复位统计清空计数、降级标记与全部时间戳', () => {
    reset()
    updateState('review')
    updateState('localReview')
    updateState('configError')
    updateState('attempt', { bodyBytes: 100 })
    updateState('succeeded', { durationMs: 10, bodyBytes: 100, inputTokens: 50 })
    updateState('verdict', { verdict: 'deny' })
    updateState('calibration')
    fail(FALLBACK_FAILURE_THRESHOLD)
    reset()
    const stats = reviewStats()
    assert.equal(stats.reviewCount, 0)
    assert.equal(stats.localReviews, 0)
    assert.equal(stats.configErrors, 0)
    assert.equal(stats.requests, 0)
    assert.equal(stats.retries, 0)
    assert.equal(stats.denied, 0)
    assert.equal(stats.calibrations, 0)
    assert.equal(stats.fallbacks, 0)
    assert.equal(stats.factorFallbacks, 0)
    assert.equal(stats.consecutiveFailures, 0)
    assert.equal(stats.degraded, false)
    assert.equal(stats.lastSuccessAt, undefined)
    assert.equal(stats.lastFailureAt, undefined)
    assert.equal(stats.lastFallbackAt, undefined)
})

test('时间戳当天只给时分秒，跨天补日期', () => {
    const at = new Date(2026, 10, 4, 15, 4, 5).getTime()
    const sameDay = new Date(2026, 10, 4, 18, 0, 0).getTime()
    const nextDay = new Date(2026, 10, 5, 9, 0, 0).getTime()
    assert.equal(formatStatTime(at, sameDay), '15:04:05')
    assert.equal(formatStatTime(at, nextDay), '2026-11-04 15:04:05')
})

test('统计载荷整体不是对象时才不可用', () => {
    assert.equal(parseStats(undefined), undefined)
    assert.equal(parseStats(null), undefined)
    assert.equal(parseStats('x'), undefined)
    assert.equal(parseStats(42), undefined)
    assert.equal(parseStats([]), undefined)
})

test('统计载荷缺字段时按默认值构造，不判为不可用', () => {
    const empty = parseStats({})
    assert.notEqual(empty, undefined)
    assert.equal(empty!.reviewCount, 0)
    assert.equal(empty!.modelReviews, 0)
    assert.equal(empty!.requests, 0)
    assert.equal(empty!.retries, 0)
    assert.equal(empty!.succeeded, 0)
    assert.equal(empty!.failed, 0)
    assert.equal(empty!.rateLimited, 0)
    assert.equal(empty!.fallbacks, 0)
    assert.equal(empty!.factorFallbacks, 0)
    assert.equal(empty!.degraded, false)
    assert.equal(empty!.averageMs, 0)
    assert.equal(empty!.factor, undefined)
    assert.equal(empty!.lastSuccessAt, undefined)

    const partial = parseStats({ reviewCount: 3, lastFactor: 1.5 })
    assert.equal(partial!.reviewCount, 3)
    assert.equal(partial!.lastFactor, 1.5)
    assert.equal(partial!.requests, 0)
    assert.equal(partial!.degraded, false)
})

test('统计载荷的非数值字段按默认值处理', () => {
    const stats = parseStats({ reviewCount: '3', requests: Number.NaN, degraded: 'true', factor: Infinity })
    assert.notEqual(stats, undefined)
    assert.equal(stats!.reviewCount, 0)
    assert.equal(stats!.requests, 0)
    assert.equal(stats!.degraded, false)
    assert.equal(stats!.factor, undefined)
})
