import assert from 'node:assert/strict'
import { test } from 'node:test'
import { budgetState, historyBytes, maxBytes, observe, resetBudget } from '../src/budget.ts'

/** 与 budget.ts 内部常量一致的测试基准值：上下文 24K，压线余量 1000。 */
const CONTEXT_TOKENS = 24 * 1024
const HARD_STATE_TOKENS = CONTEXT_TOKENS - 1000
const INITIAL_TOKEN_FACTOR = 3

/** 两个不同的观测签名，模拟配置切换。 */
const SIGNATURE = 'https://api.example/v1|false|jev-latest'
const OTHER = 'https://api.example/v1|false|jev-1.13.0'

/** 初始上限：硬上限乘初始因子。 */
const INITIAL_MAX = HARD_STATE_TOKENS * INITIAL_TOKEN_FACTOR

test('未观测前使用初始因子，上限为硬上限乘初始因子', () => {
    resetBudget()
    assert.equal(maxBytes(SIGNATURE), INITIAL_MAX)
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
    assert.equal(maxBytes(SIGNATURE), HARD_STATE_TOKENS * (1800 / 700))
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
    assert.equal(maxBytes(OTHER), INITIAL_MAX)
    const state = budgetState()
    assert.equal(state?.signature, OTHER)
    assert.equal(state?.totalBytes, 0)
    assert.equal(state?.totalTokens, 0)
    assert.equal(state?.factor, INITIAL_TOKEN_FACTOR)
})

test('切回原签名不会恢复旧累计量', () => {
    resetBudget()
    observe(SIGNATURE, 4000, 1000)
    maxBytes(OTHER)
    assert.equal(maxBytes(SIGNATURE), INITIAL_MAX)
    assert.equal(budgetState()?.totalBytes, 0)
})

test('观测到更密的文本后因子下降，上限随之收紧', () => {
    resetBudget()
    // 每 token 只有 1.5 字节，比初始的 2 更密。
    observe(SIGNATURE, 1500, 1000)
    assert.equal(budgetState()?.factor, 1.5)
    assert.equal(maxBytes(SIGNATURE), HARD_STATE_TOKENS * 1.5)
})

test('观测到更疏的文本后因子上升，上限随之放宽', () => {
    resetBudget()
    observe(SIGNATURE, 6000, 1000)
    assert.equal(budgetState()?.factor, 6)
    assert.equal(maxBytes(SIGNATURE), HARD_STATE_TOKENS * 6)
})

test('resetBudget 后回到初始状态', () => {
    resetBudget()
    observe(SIGNATURE, 4000, 1000)
    resetBudget()
    assert.equal(budgetState(), undefined)
    assert.equal(maxBytes(SIGNATURE), INITIAL_MAX)
})

test('多次观测按累计而非滑动窗口', () => {
    resetBudget()
    for (let index = 0; index < 5; index += 1) observe(SIGNATURE, 3000, 1000)
    const state = budgetState()
    assert.equal(state?.totalBytes, 15000)
    assert.equal(state?.totalTokens, 5000)
    assert.equal(state?.factor, 3)
})

test('硬上限等于上下文大小减去 1000', () => {
    resetBudget()
    // 初始因子 3：上限应为 (24K - 1000) * 3 字节。
    assert.equal(maxBytes(SIGNATURE), (24 * 1024 - 1000) * 3)
})

test('historyBytes 从上限中扣除固定开销', () => {
    resetBudget()
    const fixed = 2000
    assert.equal(historyBytes(SIGNATURE, fixed), (24 * 1024 - 1000) * 3 - fixed)
    // 与 maxBytes 的差额恰为固定开销。
    assert.equal(maxBytes(SIGNATURE) - historyBytes(SIGNATURE, fixed), fixed)
})

test('固定开销超过上限时 historyBytes 为 0', () => {
    resetBudget()
    assert.equal(historyBytes(SIGNATURE, maxBytes(SIGNATURE) + 1), 0)
    assert.equal(historyBytes(SIGNATURE, maxBytes(SIGNATURE)), 0)
})

test('固定开销非法时按 0 处理', () => {
    resetBudget()
    const limit = maxBytes(SIGNATURE)
    assert.equal(historyBytes(SIGNATURE, 0), limit)
    assert.equal(historyBytes(SIGNATURE, -10), limit)
    assert.equal(historyBytes(SIGNATURE, Number.NaN), limit)
    assert.equal(historyBytes(SIGNATURE, Number.POSITIVE_INFINITY), limit)
})

test('因子更新后 historyBytes 随之变化', () => {
    resetBudget()
    observe(SIGNATURE, 2000, 1000)
    assert.equal(budgetState()?.factor, 2)
    const fixed = 1500
    assert.equal(historyBytes(SIGNATURE, fixed), (24 * 1024 - 1000) * 2 - fixed)
})
