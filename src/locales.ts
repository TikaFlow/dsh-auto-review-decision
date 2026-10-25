/** 本地化拥有的批准文案；审查者理由在任何语言下都原样保留。 */

/** 英文批准文案。 */
const en = {
    denied: 'Auto review denied this call.',
    deniedWithReason: (reason: string): string => `Auto review denied this call: ${reason}`,
}

/** 中文批准文案。 */
const zh = {
    denied: 'Auto review 拒绝了此调用。',
    deniedWithReason: (reason: string): string => `Auto review 拒绝了此调用：${reason}`,
} satisfies typeof en

/**
 * 构造全部显示译文，且不翻译审查者的原始理由。
 * @param reason - 可选的审查者说明。
 * @returns 供 Client 本地化文本解析器使用的文案。
 */
export function deniedDisplayReason(reason?: string): Record<'en' | 'zh', string> {
    return reason === undefined
        ? { en: en.denied, zh: zh.denied }
        : { en: en.deniedWithReason(reason), zh: zh.deniedWithReason(reason) }
}
