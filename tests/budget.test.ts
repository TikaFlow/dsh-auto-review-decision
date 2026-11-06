import assert from 'node:assert/strict'
import { test } from 'node:test'
import { budgetState, fallbackFactor, historyBytes, observe, resetBudget } from '../src/budget.ts'

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

/** 两个不同的观测签名，模拟配置切换。 */
const SIGNATURE = 'https://api.example/v1|false|jev-latest'
const OTHER = 'https://api.example/v1|false|jev-1.13.0'

/** 初始上限：硬上限乘初始因子，向下取整。 */
const INITIAL_MAX = Math.floor(HARD_STATE_TOKENS * INITIAL_TOKEN_FACTOR)

/** 余量下限生效的最小上下文：8192 * 5% < 1024，故余量取 1024。 */
const MIN_CONTEXT = 8192

test('未观测前使用初始因子，上限为硬上限乘初始因子', () => {
    resetBudget()
    assert.equal(maxBytes(SIGNATURE, CONTEXT_TOKENS), INITIAL_MAX)
    assert.equal(budgetState()?.factor, INITIAL_TOKEN_FACTOR)
})

test('因子由累计值算出，而非单次比值', () => {
    resetBudget()
    observe(SIGNATURE, 1000, 500)
    assert.equal(budgetState()?.factor, 2)
    // 第二次观测的比值是 4，但累计比值是 (1000+800)/(500+200) = 2.57…
    observe(SIGNATURE, 800, 200)
    const state = budgetState()
    assert.equal(state?.totalBytes, 1800)
    assert.equal(state?.totalTokens, 700)
    assert.equal(state?.factor, 1800 / 700)
    assert.equal(maxBytes(SIGNATURE, CONTEXT_TOKENS), Math.floor(HARD_STATE_TOKENS * (1800 / 700)))
})

test('token 数非有限或非正时跳过观测，因子保持不变', () => {
    resetBudget()
    observe(SIGNATURE, 1000, 500)
    const before = budgetState()
    observe(SIGNATURE, 5000, 0)
    observe(SIGNATURE, 5000, -1)
    observe(SIGNATURE, 5000, Number.NaN)
    observe(SIGNATURE, 5000, Number.POSITIVE_INFINITY)
    assert.deepEqual(budgetState(), before)
})

test('字节数非有限或非正时同样跳过观测', () => {
    resetBudget()
    observe(SIGNATURE, 1000, 500)
    const before = budgetState()
    observe(SIGNATURE, 0, 500)
    observe(SIGNATURE, -10, 500)
    observe(SIGNATURE, Number.NaN, 500)
    assert.deepEqual(budgetState(), before)
})

test('签名变化即重置累计量与因子', () => {
    resetBudget()
    observe(SIGNATURE, 4000, 1000)
    assert.equal(budgetState()?.factor, 4)
    // 切换到另一签名：读上限时就应回到初始状态。
    assert.equal(maxBytes(OTHER, CONTEXT_TOKENS), INITIAL_MAX)
    const state = budgetState()
    assert.equal(state?.signature, OTHER)
    assert.equal(state?.totalBytes, 0)
    assert.equal(state?.totalTokens, 0)
    assert.equal(state?.factor, INITIAL_TOKEN_FACTOR)
})

test('切回原签名不会恢复旧累计量', () => {
    resetBudget()
    observe(SIGNATURE, 4000, 1000)
    maxBytes(OTHER, CONTEXT_TOKENS)
    assert.equal(maxBytes(SIGNATURE, CONTEXT_TOKENS), INITIAL_MAX)
    assert.equal(budgetState()?.totalBytes, 0)
})

test('观测到更密的文本后因子下降，上限随之收紧', () => {
    resetBudget()
    // 每 token 只有 1.5 字节，比初始的 2 更密。
    observe(SIGNATURE, 1500, 1000)
    assert.equal(budgetState()?.factor, 1.5)
    assert.equal(maxBytes(SIGNATURE, CONTEXT_TOKENS), Math.floor(HARD_STATE_TOKENS * 1.5))
})

test('观测到更疏的文本后因子上升，上限随之放宽', () => {
    resetBudget()
    observe(SIGNATURE, 6000, 1000)
    assert.equal(budgetState()?.factor, 6)
    assert.equal(maxBytes(SIGNATURE, CONTEXT_TOKENS), Math.floor(HARD_STATE_TOKENS * 6))
})

test('resetBudget 后回到初始状态', () => {
    resetBudget()
    observe(SIGNATURE, 4000, 1000)
    resetBudget()
    assert.equal(budgetState(), undefined)
    assert.equal(maxBytes(SIGNATURE, CONTEXT_TOKENS), INITIAL_MAX)
})

test('多次观测按累计而非滑动窗口', () => {
    resetBudget()
    for (let index = 0; index < 5; index += 1) observe(SIGNATURE, 3000, 1000)
    const state = budgetState()
    assert.equal(state?.totalBytes, 15000)
    assert.equal(state?.totalTokens, 5000)
    assert.equal(state?.factor, 3)
})

test('硬上限等于上下文减去余量，余量取 5% 与 1K 的较大者', () => {
    resetBudget()
    assert.equal(maxBytes(SIGNATURE, CONTEXT_TOKENS), Math.floor(HARD_STATE_TOKENS * INITIAL_TOKEN_FACTOR))
})

test('上下文窗口变化即改变上限', () => {
    resetBudget()
    // 更大上下文：硬上限随之放大，初始上限也放大。
    const bigger = CONTEXT_TOKENS * 2
    const biggerMargin = Math.max(bigger * 0.05, 1024)
    const biggerHard = bigger - biggerMargin
    assert.equal(maxBytes(SIGNATURE, bigger), Math.floor(biggerHard * INITIAL_TOKEN_FACTOR))
    // 余量下限生效：更小上下文仍按 1K 余量。
    assert.equal(maxBytes(SIGNATURE, MIN_CONTEXT), Math.floor((MIN_CONTEXT - 1024) * INITIAL_TOKEN_FACTOR))
})

test('historyBytes 从上限中扣除固定开销', () => {
    resetBudget()
    const fixed = 2000
    assert.equal(historyBytes(SIGNATURE, CONTEXT_TOKENS, fixed), Math.floor(HARD_STATE_TOKENS * INITIAL_TOKEN_FACTOR) - fixed)
    // 与 maxBytes 的差额恰为固定开销。
    assert.equal(maxBytes(SIGNATURE, CONTEXT_TOKENS) - historyBytes(SIGNATURE, CONTEXT_TOKENS, fixed), fixed)
})

test('固定开销超过上限时 historyBytes 为 0', () => {
    resetBudget()
    assert.equal(historyBytes(SIGNATURE, CONTEXT_TOKENS, maxBytes(SIGNATURE, CONTEXT_TOKENS) + 1), 0)
    assert.equal(historyBytes(SIGNATURE, CONTEXT_TOKENS, maxBytes(SIGNATURE, CONTEXT_TOKENS)), 0)
})

test('固定开销非法时按 0 处理', () => {
    resetBudget()
    const limit = maxBytes(SIGNATURE, CONTEXT_TOKENS)
    assert.equal(historyBytes(SIGNATURE, CONTEXT_TOKENS, 0), limit)
    assert.equal(historyBytes(SIGNATURE, CONTEXT_TOKENS, -10), limit)
    assert.equal(historyBytes(SIGNATURE, CONTEXT_TOKENS, Number.NaN), limit)
    assert.equal(historyBytes(SIGNATURE, CONTEXT_TOKENS, Number.POSITIVE_INFINITY), limit)
})

test('因子更新后 historyBytes 随之变化', () => {
    resetBudget()
    observe(SIGNATURE, 2000, 1000)
    assert.equal(budgetState()?.factor, 2)
    const fixed = 1500
    assert.equal(historyBytes(SIGNATURE, CONTEXT_TOKENS, fixed), Math.floor(HARD_STATE_TOKENS * 2) - fixed)
})

test('上限与历史额度都是整数', () => {
    resetBudget()
    // 构造一个产生小数的因子：3000 / 1100。
    observe(SIGNATURE, 3000, 1100)
    const factor = budgetState()?.factor ?? 0
    assert.ok(!Number.isInteger(factor), '因子应为小数，才能验证取整')
    assert.ok(Number.isInteger(maxBytes(SIGNATURE, CONTEXT_TOKENS)))
    assert.ok(Number.isInteger(historyBytes(SIGNATURE, CONTEXT_TOKENS, 1234)))
    // 向下取整，不会比未取整的值更大。
    assert.ok(maxBytes(SIGNATURE, CONTEXT_TOKENS) <= HARD_STATE_TOKENS * factor)
})

test('非 200/429 响应使因子按步长递减到下限并保持不变', () => {
    resetBudget()
    const decreasing: number[] = []
    for (let factor = INITIAL_TOKEN_FACTOR - FALLBACK_STEP; factor >= MIN_TOKEN_FACTOR; factor -= FALLBACK_STEP) {
        decreasing.push(factor)
    }
    for (const expected of decreasing) {
        fallbackFactor(SIGNATURE, 400)
        assert.equal(budgetState()?.factor, expected)
    }
    // 已到下限：继续收到非 200/429 响应，因子保持不变。
    for (const status of [400, 500, 502, 503]) fallbackFactor(SIGNATURE, status)
    assert.equal(budgetState()?.factor, MIN_TOKEN_FACTOR)
    assert.equal(maxBytes(SIGNATURE, CONTEXT_TOKENS), Math.floor(HARD_STATE_TOKENS * MIN_TOKEN_FACTOR))
})

test('429 与 200 都不回退因子', () => {
    resetBudget()
    // 尚未建立账本时，这两类状态既不回退也不建账。
    fallbackFactor(SIGNATURE, 429)
    fallbackFactor(SIGNATURE, 200)
    assert.equal(budgetState(), undefined)
    // 已回退的因子不被它们改动。
    fallbackFactor(SIGNATURE, 400)
    const before = budgetState()
    fallbackFactor(SIGNATURE, 429)
    fallbackFactor(SIGNATURE, 200)
    assert.deepEqual(budgetState(), before)
    assert.equal(budgetState()?.factor, INITIAL_TOKEN_FACTOR - FALLBACK_STEP)
})

test('回退后成功观测仍按累计值校准因子', () => {
    resetBudget()
    fallbackFactor(SIGNATURE, 400)
    assert.equal(budgetState()?.factor, INITIAL_TOKEN_FACTOR - FALLBACK_STEP)
    observe(SIGNATURE, 1000, 500)
    assert.equal(budgetState()?.factor, 2)
})
