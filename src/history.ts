/**
 * 审查历史的裁剪：权威角色永不丢弃，其余条目按「最新优先」出局，缺口在原位置留占位。
 *
 * 只依赖类型与共享常量，无宿主依赖，故可独立测试。
 *
 * @module dsh-auto-review-systemOne/history
 */

import type { HistoricalEntry, ReviewSourceRole } from './types.ts'
import { HISTORY_CHAR_BUDGET, HISTORY_WINDOW } from './shared/config.ts'

/** 权威角色：其文本定义任务、收窄动作或恢复上下文，任何裁剪都不得丢弃。 */
const AUTHORITY_ROLES: ReadonlySet<ReviewSourceRole> = new Set<ReviewSourceRole>([
    'user-instruction',
    'direct-parent-instruction',
    'constraint',
    'checkpoint',
])

/**
 * 按「重要 > 最新 > 更旧」裁剪历史：权威角色与待审调用永不丢弃，被裁掉的连续段在原位置折叠成一条占位说明，使模型把缺口视为未知而非不存在。
 * @param entries - 会话顺序排列的保留条目，最后一条是待审调用。
 * @returns 裁剪后的条目序列，缺口处为 `omitted` 占位。
 */
export function truncateHistory(entries: readonly HistoricalEntry[]): HistoricalEntry[] {
    // 最后一条是待审调用本身，它比任何历史都重要，不参与裁剪。
    const lastIndex = entries.length - 1
    const droppable = (index: number, entry: HistoricalEntry): boolean =>
        index !== lastIndex && !AUTHORITY_ROLES.has(entry.role)
    const candidates: number[] = []
    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index]
        if (entry !== undefined && droppable(index, entry)) candidates.push(index)
    }
    // 窗口只统计可丢弃条目：超出窗口的更旧条目先出局，权威角色不占名额。
    const windowStart = Math.max(0, candidates.length - HISTORY_WINDOW)
    const sizes = new Map<number, number>()
    const kept = new Set<number>()
    let total = 0
    for (let cursor = windowStart; cursor < candidates.length; cursor += 1) {
        const index = candidates[cursor]
        if (index === undefined) continue
        const entry = entries[index]
        if (entry === undefined) continue
        const size = JSON.stringify(entry).length
        sizes.set(index, size)
        kept.add(index)
        total += size
    }
    // 超字符预算时从最旧一条起依次出局，最新条目优先级更高。
    for (let cursor = windowStart; cursor < candidates.length; cursor += 1) {
        if (total <= HISTORY_CHAR_BUDGET) break
        const index = candidates[cursor]
        if (index === undefined) continue
        const size = sizes.get(index)
        if (size === undefined) continue
        total -= size
        kept.delete(index)
    }
    const result: HistoricalEntry[] = []
    let omitted = 0
    const flush = (): void => {
        if (omitted === 0) return
        result.push({
            kind: 'omitted',
            role: 'fact',
            count: omitted,
            text: `${String(omitted)} history item(s) omitted at this point; their content is unavailable.`,
        })
        omitted = 0
    }
    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index]
        if (entry === undefined) continue
        if (!droppable(index, entry) || kept.has(index)) {
            flush()
            result.push(entry)
            continue
        }
        omitted += 1
    }
    flush()
    return result
}
