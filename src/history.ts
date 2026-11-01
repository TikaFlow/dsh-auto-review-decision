/**
 * 审查历史的裁剪：权威角色与最近的若干条目永不丢弃，其余按「最新优先」出局，缺口在原位置留占位。
 *
 * @module dsh-auto-review-decision/history
 */

import type { HistoricalEntry, ReviewSourceRole } from './types.ts'
import { byteLength } from './shared/bytes.ts'
import { HISTORY_WINDOW, RECENT_KEEP } from './shared/config.ts'

/** 权威角色：其文本定义任务、收窄动作或恢复上下文，任何裁剪都不得丢弃。 */
const AUTHORITY_ROLES: ReadonlySet<ReviewSourceRole> = new Set<ReviewSourceRole>([
    'user-instruction',
    'direct-parent-instruction',
    'constraint',
    'checkpoint',
])

/**
 * 按「重要 > 最新 > 更旧」裁剪历史：权威角色、最近若干条历史与待审调用永不丢弃，
 * 被裁掉的连续段在原位置折叠成一条占位说明，使模型把缺口视为未知而非不存在。
 * @param entries - 会话顺序排列的保留条目，最后一条是待审调用。
 * @param budgetBytes - 本次允许的字节上限；权威与保护区先扣减，余额才给可丢弃条目。
 * @returns 裁剪后的条目序列，缺口处为 `omitted` 占位。
 */
export function truncateHistory(entries: readonly HistoricalEntry[], budgetBytes: number): HistoricalEntry[] {
    // 待审调用与它之前的若干条历史一律保留：前者是判定对象，后者是紧邻上下文。
    const protectedStart = Math.max(0, entries.length - RECENT_KEEP - 1)
    const droppable = (index: number, entry: HistoricalEntry): boolean =>
        index < protectedStart && !AUTHORITY_ROLES.has(entry.role)
    // 保护区与权威角色先无条件计入，它们的体积直接吃掉预算。
    let total = 0
    const candidates: number[] = []
    const pinned = new Set<number>()
    const omittedLength = JSON.stringify({
        kind: 'omitted',
        role: 'fact',
        count: 12,
            text: "12 history item(s) omitted at this point; their content is unavailable.", // +/-2 误差可接受
    }).length
    let lastOmitted = false
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]
        if (entry === undefined) continue
        const entryLength = byteLength(JSON.stringify(entry))
        if (droppable(index, entry)) {
            if (!lastOmitted && entryLength <= omittedLength) {
                pinned.add(index)
                total += entryLength
                continue
            }
            candidates.push(index)
            if (!lastOmitted) total += omittedLength
            lastOmitted = true
            continue
        }
        total += entryLength
        lastOmitted = false
    }
    // 窗口只统计可丢弃条目：超出窗口的更旧条目先出局，权威角色不占名额。
    const windowStart = Math.max(0, candidates.length - HISTORY_WINDOW)
    const sizes = new Map<number, number>()
    const kept = new Set<number>()
    for (let cursor = windowStart; cursor < candidates.length; cursor++) {
        const index = candidates[cursor]
        if (index === undefined) continue
        const entry = entries[index]
        if (entry === undefined) continue
        const size = byteLength(JSON.stringify(entry))
        sizes.set(index, size)
        kept.add(index)
        total += size
    }
    // 超预算时从最旧一条起依次出局，最新条目优先级更高。
    for (let cursor = windowStart; cursor < candidates.length; cursor++) {
        if (total <= budgetBytes) break
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
        if (!droppable(index, entry) || kept.has(index) || pinned.has(index)) {
            flush()
            result.push(entry)
            continue
        }
        omitted += 1
    }
    flush()
    return result
}
