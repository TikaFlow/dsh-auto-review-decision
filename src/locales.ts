/**
 * 本地化拥有的审批与结论文案。
 *
 * @module dsh-auto-review-decision/locales
 */

import type { ScoreQuestionId } from './shared/questions.ts'

/** 一条中英双语的文案。 */
export interface LocalizedText {
    /** 英文文案。 */
    readonly en: string
    /** 中文文案。 */
    readonly zh: string
}

/** 英文文案。 */
const en = {
    denied: 'Auto review denied this call.',
    deniedWithReason: (reason: string): string => `Auto review denied this call: ${reason}`,
    blocked: 'This call failed the safety review',
    estimate: ' (estimated)',
    denyWithLabel: (label: string, estimate: string): string => `${label}${estimate}`,
    askWithLabel: (label: string, estimate: string): string => `${label}${estimate}; execute anyway?`,
    labels: {
        malice: 'malicious intent',
        data_sensitivity: 'sensitive-data exfiltration',
        safety: 'unsafe operation',
        authorization: 'rule violation',
        description_match: 'behavior contradicting its description',
        contract: 'wrong arguments',
        scope: 'effect beyond the permitted scope',
        task_fit: 'operation unrelated to the task',
        necessity: 'unnecessary operation',
    } satisfies Record<ScoreQuestionId, string>,
}

/** 中文文案。 */
const zh = {
    denied: '自动审查拒绝了此调用。',
    deniedWithReason: (reason: string): string => `自动审查拒绝了此调用：${reason}`,
    blocked: '该调用未通过安全审查',
    estimate: '（估算）',
    denyWithLabel: (label: string, estimate: string): string => `${label}${estimate}`,
    askWithLabel: (label: string, estimate: string): string => `${label}${estimate}，是否执行？`,
    labels: {
        malice: '存在恶意意图',
        data_sensitivity: '泄露敏感数据',
        safety: '操作不安全',
        authorization: '违反规则',
        description_match: '行为与描述不符',
        contract: '传递参数错误',
        scope: '超出许可范围',
        task_fit: '操作与任务无关',
        necessity: '操作不必要',
    },
} satisfies typeof en

/** 总判定拒绝的理由正文。 */
export function blockedVerdictReason(): LocalizedText {
    return { en: en.blocked, zh: zh.blocked }
}

/**
 * 辅助问题的结论理由正文。
 * @param id - 未达标的问题 id。
 * @param estimated - 安全度是否为期望档位估算。
 * @param ask - 是否落为审批询问（携带询问后缀）。
 */
export function questionVerdictReason(id: ScoreQuestionId, estimated: boolean, ask: boolean): LocalizedText {
    const estimate = estimated ? { en: en.estimate, zh: zh.estimate } : { en: '', zh: '' }
    return {
        en: ask ? en.askWithLabel(en.labels[id], estimate.en) : en.denyWithLabel(en.labels[id], estimate.en),
        zh: ask ? zh.askWithLabel(zh.labels[id], estimate.zh) : zh.denyWithLabel(zh.labels[id], estimate.zh),
    }
}

/**
 * 构造审批询问的双语展示文案；理由正文按语言各自携带。
 * @param reason - 可选的审查理由（双语）。
 * @returns 供 Client 本地化文本解析器使用的文案。
 */
export function deniedDisplayReason(reason?: LocalizedText): Record<'en' | 'zh', string> {
    return reason === undefined
        ? { en: en.denied, zh: zh.denied }
        : { en: en.deniedWithReason(reason.en), zh: zh.deniedWithReason(reason.zh) }
}
