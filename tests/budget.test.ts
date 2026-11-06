import assert from 'node:assert/strict'
import { test } from 'node:test'
import { budgetState, fallbackFactor, historyBytes, observe } from '../src/budget.ts'

/** 上限即固定开销为 0 时的历史额度；`maxBytes` 已从实现移除，测试沿用同一算式。 */
function maxBytes(signature: string, contextTokens: number): number {
    return historyBytes(signature, contextTokens, 0)
}

/** 与 budget.ts 内部常量一致的测试基准值：上下文 24K，余量取 5% 与 1K 的较大者。 */
const CONTEXT_TOKENS = 24 * 1024
const CONTEXT_MARGIN_TOKENS = Math.max(CONTEXT_TOKENS * 0.05, 1024)
const HARD_STATE_TOKENS = CONTEXT_TOKENS - CONTEXT_MARGIN_TOKENS
const INITIAL_TOKEN_FACTOR = 2.5
const FALLBACK_STEP = 0.25
const MIN_TOKEN_FACTOR = 1.25

/** 每个用例使用独立签名：账本按签名天然隔离，用例之间无需复位。 */
function signatureFor(scope: string, model = 'jev-latest'): string {
    return `https://api.example/v1|false|${model}|${scope}`
}

/** 初始上限：硬上限乘初始因子，向下取整。 */
const INITIAL_MAX = Math.floor(HARD_STATE_TOKENS * INITIAL_TOKEN_FACTOR)

/** 余量下限生效的最小上下文：8192 * 5% < 1024，故余量取 1024。 */
const MIN_CONTEXT = 8192

test('未观测前使用初始因子，上限为硬上限乘初始因子', () => {
    const signature = signatureFor('initial')
    assert.equal(maxBytes(signature, CONTEXT_TOKENS), INITIAL_MAX)
    assert.equal(budgetState()?.factor, INITIAL_TOKEN_FACTOR)
})

test('因子由累计值算出，而非单次比值', () => {
    const signature = signatureFor('accumulated')
    observe(signature, 1000, 500)
    assert.equal(budgetState()?.factor, 2)
    // 第二次观测的比值是 4，但累计比值是 (1000+800)/(500+200) = 2.57…
    observe(signature, 800, 200)
    const state = budgetState()
    assert.equal(state?.totalBytes, 1800)
    assert.equal(state?.totalTokens, 700)
    assert.equal(state?.factor, 1800 / 700)
    assert.equal(maxBytes(signature, CONTEXT_TOKENS), Math.floor(HARD_STATE_TOKENS * (1800 / 700)))
})

test('token 数非有限或非正时跳过观测，因子保持不变', () => {
    const signature = signatureFor('invalid-tokens')
    observe(signature, 1000, 500)
    const before = budgetState()
    observe(signature, 5000, 0)
    observe(signature, 5000, -1)
    observe(signature, 5000, Number.NaN)
    observe(signature, 5000, Number.POSITIVE_INFINITY)
    assert.deepEqual(budgetState(), before)
})

test('字节数非有限或非正时同样跳过观测', () => {
    const signature = signatureFor('invalid-bytes')
    observe(signature, 1000, 500)
    const before = budgetState()
    observe(signature, 0, 500)
    observe(signature, -10, 500)
    observe(signature, Number.NaN, 500)
    assert.deepEqual(budgetState(), before)
})

test('签名变化即重置累计量与因子', () => {
    const signature = signatureFor('switch')
    const other = signatureFor('switch', 'jev-1.13.0')
    observe(signature, 4000, 1000)
    assert.equal(budgetState()?.factor, 4)
    // 切换到另一签名：读上限时就应回到初始状态。
    assert.equal(maxBytes(other, CONTEXT_TOKENS), INITIAL_MAX)
    const state = budgetState()
    assert.equal(state?.signature, other)
    assert.equal(state?.totalBytes, 0)
    assert.equal(state?.totalTokens, 0)
    assert.equal(state?.factor, INITIAL_TOKEN_FACTOR)
})

test('切回原签名不会恢复旧累计量', () => {
    const signature = signatureFor('switch-back')
    const other = signatureFor('switch-back', 'jev-1.13.0')
    observe(signature, 4000, 1000)
    maxBytes(other, CONTEXT_TOKENS)
    assert.equal(maxBytes(signature, CONTEXT_TOKENS), INITIAL_MAX)
    assert.equal(budgetState()?.totalBytes, 0)
})

test('观测到更密的文本后因子下降，上限随之收紧', () => {
    const signature = signatureFor('denser')
    // 每 token 只有 1.5 字节，比初始的 2 更密。
    observe(signature, 1500, 1000)
    assert.equal(budgetState()?.factor, 1.5)
    assert.equal(maxBytes(signature, CONTEXT_TOKENS), Math.floor(HARD_STATE_TOKENS * 1.5))
})

test('观测到更疏的文本后因子上升，上限随之放宽', () => {
    const signature = signatureFor('sparser')
    observe(signature, 6000, 1000)
    assert.equal(budgetState()?.factor, 6)
    assert.equal(maxBytes(signature, CONTEXT_TOKENS), Math.floor(HARD_STATE_TOKENS * 6))
})

test('多次观测按累计而非滑动窗口', () => {
    const signature = signatureFor('cumulative')
    for (let index = 0; index < 5; index += 1) observe(signature, 3000, 1000)
    const state = budgetState()
    assert.equal(state?.totalBytes, 15000)
    assert.equal(state?.totalTokens, 5000)
    assert.equal(state?.factor, 3)
})

test('硬上限等于上下文减去余量，余量取 5% 与 1K 的较大者', () => {
    const signature = signatureFor('hard-limit')
    assert.equal(maxBytes(signature, CONTEXT_TOKENS), Math.floor(HARD_STATE_TOKENS * INITIAL_TOKEN_FACTOR))
})

test('上下文窗口变化即改变上限', () => {
    const signature = signatureFor('context-window')
    // 更大上下文：硬上限随之放大，初始上限也放大。
    const bigger = CONTEXT_TOKENS * 2
    const biggerMargin = Math.max(bigger * 0.05, 1024)
    const biggerHard = bigger - biggerMargin
    assert.equal(maxBytes(signature, bigger), Math.floor(biggerHard * INITIAL_TOKEN_FACTOR))
    // 余量下限生效：更小上下文仍按 1K 余量。
    assert.equal(maxBytes(signature, MIN_CONTEXT), Math.floor((MIN_CONTEXT - 1024) * INITIAL_TOKEN_FACTOR))
})

test('historyBytes 从上限中扣除固定开销', () => {
    const signature = signatureFor('fixed-overhead')
    const fixed = 2000
    assert.equal(historyBytes(signature, CONTEXT_TOKENS, fixed), Math.floor(HARD_STATE_TOKENS * INITIAL_TOKEN_FACTOR) - fixed)
    // 与 maxBytes 的差额恰为固定开销。
    assert.equal(maxBytes(signature, CONTEXT_TOKENS) - historyBytes(signature, CONTEXT_TOKENS, fixed), fixed)
})

test('固定开销超过上限时 historyBytes 为 0', () => {
    const signature = signatureFor('over-overhead')
    assert.equal(historyBytes(signature, CONTEXT_TOKENS, maxBytes(signature, CONTEXT_TOKENS) + 1), 0)
    assert.equal(historyBytes(signature, CONTEXT_TOKENS, maxBytes(signature, CONTEXT_TOKENS)), 0)
})

test('固定开销非法时按 0 处理', () => {
    const signature = signatureFor('invalid-overhead')
    const limit = maxBytes(signature, CONTEXT_TOKENS)
    assert.equal(historyBytes(signature, CONTEXT_TOKENS, 0), limit)
    assert.equal(historyBytes(signature, CONTEXT_TOKENS, -10), limit)
    assert.equal(historyBytes(signature, CONTEXT_TOKENS, Number.NaN), limit)
    assert.equal(historyBytes(signature, CONTEXT_TOKENS, Number.POSITIVE_INFINITY), limit)
})

test('因子更新后 historyBytes 随之变化', () => {
    const signature = signatureFor('factor-update')
    observe(signature, 2000, 1000)
    assert.equal(budgetState()?.factor, 2)
    const fixed = 1500
    assert.equal(historyBytes(signature, CONTEXT_TOKENS, fixed), Math.floor(HARD_STATE_TOKENS * 2) - fixed)
})

test('上限与历史额度都是整数', () => {
    const signature = signatureFor('integers')
    // 构造一个产生小数的因子：3000 / 1100。
    observe(signature, 3000, 1100)
    const factor = budgetState()?.factor ?? 0
    assert.ok(!Number.isInteger(factor), '因子应为小数，才能验证取整')
    assert.ok(Number.isInteger(maxBytes(signature, CONTEXT_TOKENS)))
    assert.ok(Number.isInteger(historyBytes(signature, CONTEXT_TOKENS, 1234)))
    // 向下取整，不会比未取整的值更大。
    assert.ok(maxBytes(signature, CONTEXT_TOKENS) <= HARD_STATE_TOKENS * factor)
})

test('非 200/429 响应使因子按步长递减到下限并保持不变', () => {
    const signature = signatureFor('fallback')
    const decreasing: number[] = []
    for (let factor = INITIAL_TOKEN_FACTOR - FALLBACK_STEP; factor >= MIN_TOKEN_FACTOR; factor -= FALLBACK_STEP) {
        decreasing.push(factor)
    }
    for (const expected of decreasing) {
        fallbackFactor(signature, 400)
        assert.equal(budgetState()?.factor, expected)
    }
    // 已到下限：继续收到非 200/429 响应，因子保持不变。
    for (const status of [400, 500, 502, 503]) fallbackFactor(signature, status)
    assert.equal(budgetState()?.factor, MIN_TOKEN_FACTOR)
    assert.equal(maxBytes(signature, CONTEXT_TOKENS), Math.floor(HARD_STATE_TOKENS * MIN_TOKEN_FACTOR))
})

test('429 与 200 都不回退因子', () => {
    const signature = signatureFor('rate-limit')
    const baseline = signatureFor('rate-limit', 'jev-1.13.0')
    // 用另一签名的账本作基线：若 429/200 为目标签名建账，当前签名就会变成目标签名。
    maxBytes(baseline, CONTEXT_TOKENS)
    const untouched = budgetState()
    fallbackFactor(signature, 429)
    fallbackFactor(signature, 200)
    assert.deepEqual(budgetState(), untouched)
    // 已回退的因子不被它们改动。
    fallbackFactor(signature, 400)
    const before = budgetState()
    fallbackFactor(signature, 429)
    fallbackFactor(signature, 200)
    assert.deepEqual(budgetState(), before)
    assert.equal(budgetState()?.factor, INITIAL_TOKEN_FACTOR - FALLBACK_STEP)
})

test('回退后成功观测仍按累计值校准因子', () => {
    const signature = signatureFor('fallback-then-observe')
    fallbackFactor(signature, 400)
    assert.equal(budgetState()?.factor, INITIAL_TOKEN_FACTOR - FALLBACK_STEP)
    observe(signature, 1000, 500)
    assert.equal(budgetState()?.factor, 2)
})
