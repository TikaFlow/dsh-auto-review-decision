/**
 * 浏览器半的预设文案映射：权限预设机器值 → 文案键。
 *
 * @module dsh-auto-review-systemOne/client/preset-labels
 */

import type { CardLocaleKey } from './locale.ts'

/** 预设机器值 → 文案键。 */
export const PRESET_LABELS: Readonly<Record<string, CardLocaleKey>> = {
    'read-only': 'presetReadOnly',
    'workspace-write': 'presetWorkspaceWrite',
    'danger-full-access': 'presetFullAccess',
}

/**
 * 取一个预设的本地化名称；未知预设回退到机器值。
 * @param value - 预设机器值。
 * @param t - 文案查询。
 */
export function presetName(value: string, t: (key: CardLocaleKey) => string): string {
    const key = PRESET_LABELS[value]
    return key === undefined ? value : t(key)
}
