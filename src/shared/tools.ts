/**
 * 跨半共享的未知值判定：Node 半与浏览器半共用，零宿主依赖。
 *
 * @module dsh-auto-review-decision/shared/tools
 */

/** 判断一个未知值是否为对象记录，而非 null 或数组。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}
