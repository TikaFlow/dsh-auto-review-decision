/**
 * 审查历史的分层裁剪：末十条、头十条内的权威角色与待审调用永不丢弃；
 * 其余按「中间非权威（旧→新）→ 中间权威（旧→新）→ 头部非权威（旧→新）」逐层出局；
 * 被裁掉的连续段在原位置折叠成占位说明，使模型把缺口视为未知而非不存在。
 *
 * @module dsh-auto-review-decision/history
 */

import type { HistoricalEntry, ReviewSourceRole } from './types.ts'
import { byteLength } from './shared/bytes.ts'
import { HEAD_KEEP, RECENT_KEEP } from './shared/config.ts'

/** 权威角色：其文本定义任务、收窄动作或恢复上下文。 */
const AUTHORITY_ROLES: ReadonlySet<ReviewSourceRole> = new Set<ReviewSourceRole>([
    'user-instruction',
    'direct-parent-instruction',
    'constraint',
    'checkpoint',
])

/**
 * 按分层逐层裁剪历史
 * 被裁掉的连续段在原位置折叠成一条占位说明
 * @param entries - 会话顺序排列的保留条目，最后一条是待审调用。
 * @param budgetBytes - 本次允许的字节上限
 * @returns 裁剪后的条目序列，缺口处为 `omitted` 占位。
 */
export function truncateHistory(entries: readonly HistoricalEntry[], budgetBytes: number): HistoricalEntry[] {
    const n = entries.length
    // 末十条与待审无条件保留
    const lastStart = Math.max(0, n - 1 - RECENT_KEEP)
    const firstEnd = Math.min(HEAD_KEEP, n - 2)
    const sizes: (number | undefined)[] = new Array<number | undefined>(n)
    // 三层出局顺序：中间非权威、中间权威、头部非权威；层内从旧到新。
    let total = 0
    const tiers: number[][] = [[], [], []]
    for (const [index, entry] of entries.entries()) {
        if (entry === undefined) continue
        const size = byteLength(JSON.stringify(entry))
        sizes[index] = size
        total += size
        if (index >= lastStart) continue
        const authority = AUTHORITY_ROLES.has(entry.role)
        if (index <= firstEnd) {
            if (!authority) tiers[2].push(index)
        } else if (authority) {
            tiers[1].push(index)
        } else {
            tiers[0].push(index)
        }
    }
    // 占位体积估算固定取 12 条：实际段长不同只带来个位数字节偏差。
    const omittedLength = JSON.stringify({
        kind: 'omitted',
        role: 'fact',
        count: 12,
            text: '12 history item(s) omitted at this point; their content is unavailable.', // +/-2 误差可接受
    }).length
    const removed = new Set<number>()
    for (const tier of tiers) {
        for (const index of tier) {
            if (total <= budgetBytes) break
            const size = sizes[index]
            if (size === undefined) continue
            // 缺口段起点的小条目钉住保留：自身体积比它要占的占位更小。
            if (size <= omittedLength && !removed.has(index - 1)) continue
            total -= size
            removed.add(index)
            if (!removed.has(index - 1)) total += omittedLength
        }
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
    for (const [index, entry] of entries.entries()) {
        if (entry === undefined) continue
        if (removed.has(index)) {
            omitted++
            continue
        }
        flush()
        result.push(entry)
    }
    flush()
    return result
}
