/**
 * 审查配置的 schema 与加载期校验。
 *
 * @module dsh-auto-review-systemOne/config
 */

import z from '@deepseek-ai/schemastery'
import {
    CONFIG_LABELS,
    DEFAULT_CONFIG,
    MAX_CONFIDENCE_THRESHOLD,
    MIN_CONFIDENCE_THRESHOLD,
    PRESET_OPTIONS,
    baseURLProblem,
    type ConfigKey,
    type PresetOption,
    type ReviewConfig,
} from './shared/config.ts'

/** 宿主配置 schema；字段全为 `.volatile()`，改完下次审查即生效。 */
export const Config = z.object({
    baseURL: z.string().default(DEFAULT_CONFIG.baseURL).description(CONFIG_LABELS.baseURL).volatile(),
    fullURL: z.boolean().default(DEFAULT_CONFIG.fullURL).description(CONFIG_LABELS.fullURL).volatile(),
    model: z.string().default(DEFAULT_CONFIG.model).description(CONFIG_LABELS.model).volatile(),
    confidenceThreshold: z.number().min(MIN_CONFIDENCE_THRESHOLD).max(MAX_CONFIDENCE_THRESHOLD)
        .default(DEFAULT_CONFIG.confidenceThreshold).description(CONFIG_LABELS.confidenceThreshold).volatile(),
    onSessionReset: z.union([...PRESET_OPTIONS]).default(DEFAULT_CONFIG.onSessionReset)
        .description(CONFIG_LABELS.onSessionReset).volatile(),
    onApiUnavailable: z.union([...PRESET_OPTIONS]).default(DEFAULT_CONFIG.onApiUnavailable)
        .description(CONFIG_LABELS.onApiUnavailable).volatile(),
    notifyOnFallback: z.boolean().default(DEFAULT_CONFIG.notifyOnFallback)
        .description(CONFIG_LABELS.notifyOnFallback).volatile(),
})

/** 配置项的运行时形态：字段可能被宿主包成 volatile 引用。 */
export type ConfigInput = Partial<Record<ConfigKey, unknown>>

/** 一次读取的结果。 */
export interface ConfigRead {
    /** 已解析的取值；缺失项落默认值。 */
    readonly values: ReviewConfig
    /** 必填但尚未配置的字段键。 */
    readonly missing: readonly ConfigKey[]
}

/** 取出字段当前值：volatile 引用取快照。 */
function current(raw: unknown): unknown {
    if (raw !== null && typeof raw === 'object') {
        const get = (raw as { readonly get?: unknown }).get
        if (typeof get === 'function') return (get as () => unknown).call(raw)
    }
    return raw
}

/** 拼一条加载期错误：指明配置项与原因。 */
function invalid(key: ConfigKey, detail: string): Error {
    return new Error(`auto-review: 配置项 "${key}"（${CONFIG_LABELS[key]}）${detail}`)
}

/** 读字符串字段：缺失落默认，非字符串非法。 */
function readString(input: ConfigInput, key: 'baseURL' | 'model', fallback: string): string {
    const value = current(input[key])
    if (value === undefined || value === null) return fallback
    if (typeof value !== 'string') throw invalid(key, '必须是字符串')
    return value.trim()
}

/** 读阈值：缺失落默认，非有限数或越界非法（不 clamp）。 */
function readThreshold(input: ConfigInput): number {
    const value = current(input.confidenceThreshold)
    if (value === undefined || value === null) return DEFAULT_CONFIG.confidenceThreshold
    if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid('confidenceThreshold', '必须是有限数')
    if (value < MIN_CONFIDENCE_THRESHOLD || value > MAX_CONFIDENCE_THRESHOLD) {
        throw invalid('confidenceThreshold', `必须在 ${MIN_CONFIDENCE_THRESHOLD} 与 ${MAX_CONFIDENCE_THRESHOLD} 之间`)
    }
    return value
}

/** 判断一个字符串是否为候选预设。 */
function isPresetOption(value: string): value is PresetOption {
    return (PRESET_OPTIONS as readonly string[]).includes(value)
}

/** 读预设去向：缺失落默认，不在候选表内非法。 */
function readTarget(
    input: ConfigInput,
    key: 'onSessionReset' | 'onApiUnavailable',
): PresetOption {
    const value = current(input[key])
    if (value === undefined || value === null) return DEFAULT_CONFIG[key]
    if (typeof value !== 'string' || !isPresetOption(value)) {
        throw invalid(key, `必须是 ${PRESET_OPTIONS.join(' / ')} 之一`)
    }
    return value
}

/** 读布尔字段：缺失落默认，非布尔非法。 */
function readBoolean(input: ConfigInput, key: 'fullURL' | 'notifyOnFallback'): boolean {
    const value = current(input[key])
    if (value === undefined || value === null) return DEFAULT_CONFIG[key]
    if (typeof value !== 'boolean') throw invalid(key, '必须是布尔值')
    return value
}

/**
 * 校验并解析配置。
 *
 * 字段存在但非法是加载期错误，直接抛出；必填项为空不算非法，
 * 只记入 `missing`，由审查时 fail-closed 提示补齐。
 * @param input - `apply` 收到的配置段。
 * @returns 已解析的取值与缺失项。
 * @throws 配置项取值非法时抛出，消息指明该配置项。
 */
export function readReviewConfig(input: ConfigInput | undefined): ConfigRead {
    const raw: ConfigInput = input ?? {}
    const baseURL = readString(raw, 'baseURL', '')
    const fullURL = readBoolean(raw, 'fullURL')
    const urlProblem = baseURLProblem(baseURL)
    if (urlProblem !== undefined) throw invalid('baseURL', urlProblem)
    const values: ReviewConfig = {
        baseURL,
        fullURL,
        model: readString(raw, 'model', ''),
        confidenceThreshold: readThreshold(raw),
        onSessionReset: readTarget(raw, 'onSessionReset'),
        onApiUnavailable: readTarget(raw, 'onApiUnavailable'),
        notifyOnFallback: readBoolean(raw, 'notifyOnFallback'),
    }
    const missing: ConfigKey[] = []
    if (values.baseURL === '') missing.push('baseURL')
    return { values, missing }
}

/** 当前生效配置段的来源；未接线时回退默认。 */
let configInput: () => ConfigInput | undefined = () => undefined

/**
 * 接线配置来源，供每次审查重读。
 * @param source - 返回当前配置段。
 */
export function setConfigInput(source: () => ConfigInput | undefined): void {
    configInput = source
}

/**
 * 读取当前生效配置。
 * @returns 已解析的取值与缺失项。
 * @throws 配置项取值非法时抛出。
 */
export function getReviewConfig(): ConfigRead {
    return readReviewConfig(configInput())
}
