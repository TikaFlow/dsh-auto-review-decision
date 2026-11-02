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

/** 一个可整体出局的连续小条目段：`[start, end)`，`bytes` 为段内字节数合计。 */
interface PinUnit {
    start: number
    end: number
    bytes: number
}

/** 出局候选：单条下标，或整体出局的连续小条目段。 */
type Candidate = number | PinUnit

/**
 * 按分层逐层裁剪历史；连续小条目段作为整体单元参与分层。
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
    const tiers: Candidate[][] = [[], [], []]
    // 占位体积估算固定取 12 条：实际段长不同只带来个位数字节偏差。
    const omittedLength = JSON.stringify({
        kind: 'omitted',
        role: 'fact',
        count: 12,
        text: '12 history item(s) omitted at this point; their content is unavailable.', // +/-2 误差可接受
    }).length

    let pin = { start: -1, end: 0, bytes: 0, tier: 0 | 1 | 2 }
    const endPin = (index: number): void => {
        if (pin.start === -1) return

        pin.end = index
        tiers[pin.tier].push({ ...pin })

        pin.start = -1
        pin.end = 0
        pin.bytes = 0
    }
    // true 表示未入段，需要额外入层
    const addPin = (index: number, size: number, tier: 0 | 1 | 2): boolean => {
        if (size > omittedLength) {
            endPin(index)
            return true
        }

        if (pin.start === -1) {
            pin.tier = tier
            pin.start = index
            pin.bytes = size
            return false
        }

        if (pin.tier !== tier || pin.bytes > 8 * omittedLength) {
            endPin(index)
            return addPin(index, size, tier)
        }

        pin.bytes += size
        return false
    }

    // 识别
    for (const [index, entry] of entries.entries()) {
        if (entry === undefined) {
            endPin(index)
            continue
        }
        const size = byteLength(JSON.stringify(entry))
        sizes[index] = size
        total += size
        const authority = AUTHORITY_ROLES.has(entry.role)

        if (index >= lastStart) {
            endPin(index)
        } else if (index <= firstEnd) {
            if (!authority) {
                if (addPin(index, size, 2)) tiers[2].push(index)
            } else {
                endPin(index)
            }
        } else if (authority) {
            if (addPin(index, size, 1)) tiers[1].push(index)
        } else {
            if (addPin(index, size, 0)) tiers[0].push(index)
        }
    }
    endPin(n)

    // 标记
    const removed = new Set<number>()
    for (const tier of tiers) {
        for (const item of tier) {
            if (total <= budgetBytes) break
            const leftOmitted = removed.has((typeof item === 'number' ? item : item.start) - 1)
            if (typeof item === 'number') {
                const size = sizes[item]
                if (size === undefined) continue
                removed.add(item)
                total -= size
                if (!leftOmitted) total += omittedLength
            } else {
                if (item.bytes <= omittedLength && !leftOmitted) continue
                // 整段原子出局
                for (let i = item.start; i < item.end; i++) removed.add(i)
                total -= item.bytes
                if (!leftOmitted) total += omittedLength
            }
        }
    }

    // 剪裁
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
