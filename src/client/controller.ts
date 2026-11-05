/**
 * 卡片的表单模型：把配置 scope 与凭据状态投影成卡片状态。
 *
 * @module dsh-auto-review-decision/client/controller
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import {
    SettingsFormModel,
    settingsTextField,
    type SettingsFieldState,
    type SettingsFieldSpec,
    type SettingsFormActions,
    type SettingsFormScope,
    type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { } from '@deepseek-ai/dsh-api-remotes/client'
import {
    CLIENT_TIMEOUT_MS,
    CONFIG_NS,
    CREDENTIAL_REF,
    DEFAULT_CONFIG,
    MAX_CONFIDENCE_THRESHOLD,
    MIN_CONFIDENCE_THRESHOLD,
    PRESET_OPTIONS,
    STATS_URL,
    TEST_URL,
    baseURLProblem,
    parseAuthHeader,
    parseContextTokens,
    parseToolWhitelist,
    type ProbeFailureCode,
} from '../shared/config.ts'
import { parseStats, type ReviewStats } from '../shared/stats.ts'
import { isRecord } from '../shared/tools.ts'

/** 一次连通性测试的结果；成功不带细节。 */
export type TestOutcome = {
    readonly kind: 'passed'
} | {
    readonly kind: 'failed'
    /** 插件侧失败码；卡片据此取本地化文案。 */
    readonly code?: ProbeFailureCode
    /** 动态诊断原文，卡片原样呈现。 */
    readonly message?: string
}

/** 测试状态；null 为未测过。 */
export type TestState = {
    readonly kind: 'running'
} | TestOutcome | null

/** 一次测试的类别：单发或双发。 */
export type TestKind = 'single' | 'double'

/** 卡片上一次测试的载体。 */
interface EndpointProbe {
    readonly baseURL: string
    readonly fullURL: boolean
    /** 草稿原文；由宿主测试路由归一并校验。 */
    readonly authHeader: string
    readonly model: string
    readonly apiKey: string
    readonly contextTokens?: number
}

/**
 * 请求宿主按草稿配置发一次测试请求；载荷带 `contextTokens` 时宿主走双发。
 * 密钥只送到宿主的测试路由，由它代发决策请求，浏览器不直连。
 * 探活每次尝试 15s，双发串行两次共 30s，故客户端单发与双发都等 30s。
 * 调用方中止（卡片卸载或作废结果）与超时任一触发都会取消请求，宿主侧随之中止决策调用。
 * @returns 通过与否。
 */
async function probeEndpoint(probe: EndpointProbe, signal: AbortSignal): Promise<TestOutcome> {
    try {
        const response = await fetch(TEST_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(probe),
            signal: AbortSignal.any([AbortSignal.timeout(CLIENT_TIMEOUT_MS), signal]),
        })
        if (!response.ok) {
            const reason = (await response.text().catch(() => '')).trim()
            return { kind: 'failed', message: reason === '' ? `HTTP ${String(response.status)}` : reason }
        }
        const body: unknown = await response.json()
        if (!isRecord(body)) return { kind: 'failed', code: 'invalidResponse' }
        if (body.ok !== true) {
            const code = typeof body.code === 'string' && PROBE_CODES.has(body.code) ? body.code as ProbeFailureCode : undefined
            return code !== undefined
                ? { kind: 'failed', code }
                : { kind: 'failed', message: typeof body.message === 'string' ? body.message : undefined, code: 'probeFailed' }
        }
        return { kind: 'passed' }
    } catch (error: unknown) {
        if (error instanceof Error && error.message !== '') return { kind: 'failed', message: error.message }
        return { kind: 'failed', code: 'probeFailed' }
    }
}

/** 宿主可能回传的插件侧失败码集合。 */
const PROBE_CODES: ReadonlySet<string> = new Set<ProbeFailureCode>([
    'baseURLInvalid',
    'credentialMissing',
    'authHeaderInvalid',
    'rateLimited',
    'networkFailed',
    'unknownFailure',
    'invalidResponse',
    'probeFailed',
])

/** 阈值字段的 spec：空串清除，越界非法。 */
const thresholdField: SettingsFieldSpec = {
    field: 'confidenceThreshold',
    format: value => typeof value === 'number' ? String(value) : '',
    parse: (text) => {
        const trimmed = text.trim()
        if (trimmed === '') return { kind: 'clear' }
        const parsed = Number(trimmed)
        return Number.isFinite(parsed) && parsed >= MIN_CONFIDENCE_THRESHOLD && parsed <= MAX_CONFIDENCE_THRESHOLD
            ? { kind: 'set', value: parsed }
            : undefined
    },
}

/** 基址字段的 spec：空串清除，非法 URL 阻止保存。 */
const baseURLField: SettingsFieldSpec = {
    ...settingsTextField('baseURL'),
    parse: (text) => {
        const trimmed = text.trim()
        if (trimmed === '') return { kind: 'clear' }
        return baseURLProblem(trimmed) === undefined ? { kind: 'set', value: trimmed } : undefined
    },
}

/** 认证头字段的 spec：空串清除，归一保存（全角 `！`、`!` 前缀、空白），非法头名阻止保存。 */
const authHeaderField: SettingsFieldSpec = {
    ...settingsTextField('authHeader'),
    parse: (text) => {
        const trimmed = text.trim()
        if (trimmed === '') return { kind: 'clear' }
        const parsed = parseAuthHeader(trimmed)
        return parsed === undefined ? undefined : { kind: 'set', value: parsed }
    },
}

/** 上下文窗口字段的 spec：空串清除，纯数字或 K/M 单位换算，其余阻止保存。 */
const contextTokensField: SettingsFieldSpec = {
    field: 'contextTokens',
    format: value => typeof value === 'number' ? String(value) : '',
    parse: (text) => {
        const trimmed = text.trim()
        if (trimmed === '') return { kind: 'clear' }
        const tokens = parseContextTokens(trimmed)
        return tokens === undefined ? undefined : { kind: 'set', value: tokens }
    },
}

/** 工具白名单字段的 spec：空串清除，其余解析为去空白、滤空后的数组。 */
const toolWhitelistField: SettingsFieldSpec = {
    field: 'toolWhitelist',
    format: value => Array.isArray(value) ? value.join(',') : '',
    parse: (text) => {
        const trimmed = text.trim()
        if (trimmed === '') return { kind: 'clear' }
        return { kind: 'set', value: parseToolWhitelist(trimmed) }
    },
}

/** 预设字段的 spec：只接受候选表内的值。 */
function presetField(field: 'onSessionReset' | 'onApiUnavailable'): SettingsFieldSpec {
    return {
        field,
        format: value => typeof value === 'string' ? value : '',
        parse: (text) => {
            const trimmed = text.trim()
            if (trimmed === '') return { kind: 'clear' }
            return PRESET_OPTIONS.includes(trimmed as never) ? { kind: 'set', value: trimmed } : undefined
        },
    }
}

/** 把布尔字段的草稿文本读成布尔值。 */
function draftBoolean(text: string): boolean {
    return text === 'true'
}

/** 布尔字段的 spec：以 `true`/`false` 文本承载。 */
function booleanField(field: 'fullURL' | 'notifyOnFallback'): SettingsFieldSpec {
    return {
        field,
        format: value => typeof value === 'boolean' ? String(value) : '',
        parse: (text) => {
            const trimmed = text.trim()
            if (trimmed === 'true') return { kind: 'set', value: true }
            if (trimmed === 'false') return { kind: 'set', value: false }
            return undefined
        },
    }
}

/** 卡片渲染所需的全部状态。 */
export interface CardState extends SettingsFormShell {
    /** 基址字段。 */
    readonly baseURL: SettingsFieldState
    /** 完整 URL 开关。 */
    readonly fullURL: boolean
    /** 认证头字段。 */
    readonly authHeader: SettingsFieldState
    /** 模型字段。 */
    readonly model: SettingsFieldState
    /** 上下文窗口字段。 */
    readonly contextTokens: SettingsFieldState
    /** 工具白名单字段。 */
    readonly toolWhitelist: SettingsFieldState
    /** 草稿解析后的工具数（滤空后），供提示展示。 */
    readonly toolWhitelistCount: number
    /** 阈值字段。 */
    readonly confidenceThreshold: SettingsFieldState
    /** 卸载去向（草稿文本）。 */
    readonly onSessionReset: string
    /** 降级去向（草稿文本）。 */
    readonly onApiUnavailable: string
    /** 降级提示（草稿布尔）。 */
    readonly notifyOnFallback: boolean
    /** 凭据草稿文本，每次加载均为空。 */
    readonly apiKey: SettingsFieldState
    /** 宿主报告的凭据是否已配置。 */
    readonly apiKeyConfigured: boolean
    /** 宿主凭据是否可写。 */
    readonly apiKeyWritable: boolean
    /** 三个必填值（基址、模型、密钥）是否齐备，含草稿。 */
    readonly testable: boolean
    /** 单发测试的状态。 */
    readonly test: TestState
    /** 双发测试的状态；与单发各自独立。 */
    readonly testDouble: TestState
    /** 最近一次启动的测试；状态行展示该次测试的结论，未测过为 null。 */
    readonly lastTest: TestKind | null
    /** 审查状态统计；尚未读到或路由不可用时为 null。 */
    readonly stats: ReviewStats | null
}

/** 卡片从注册侧注入的面。 */
export interface CardFace extends SettingsFormActions {
    /** 渲染器绑定的快照选择器。 */
    readonly hooks: { readonly card: SnapshotStore<CardState> }
    /** 切换两个预设字段。 */
    readonly setPreset: (field: 'onSessionReset' | 'onApiUnavailable', value: string) => void
    /** 切换完整 URL 开关。 */
    readonly setFullURL: (value: boolean) => void
    /** 切换降级提示。 */
    readonly setNotify: (value: boolean) => void
    /** 连通性测试。 */
    readonly test: () => void
    /** 双发测试。 */
    readonly testDouble: () => void
    /** 读取审查状态统计。 */
    readonly refreshStats: () => void
    /** 作废上次结果；卡片卸载时调用。 */
    readonly resetTest: () => void
}

/** 凭据状态。 */
interface CredentialState {
    /** 是否已配置。 */
    readonly configured: boolean
    /** 是否可写。 */
    readonly writable: boolean
}

/** 把配置表单与凭据状态编排成卡片状态。 */
export class CardController {
    private readonly form: SettingsFormModel<Record<string, unknown>>
    private readonly store: SnapshotStore<CardState>
    private readonly disposers: (() => void)[] = []
    private credential: CredentialState = { configured: false, writable: true }
    /** 单发测试状态。 */
    private single: TestState = null
    /** 双发测试状态；与单发各自独立。 */
    private double: TestState = null
    /** 最近一次启动的测试类别；决定状态行展示哪一份结论。 */
    private lastTest: TestKind | null = null
    private stats: ReviewStats | null = null
    /** 测试代号：每次开始测试或作废结果都递增，返回时不一致即丢弃过期结果。 */
    private runId = 0
    /** 在途测试的中止器；作废结果时中止请求，宿主侧同步取消决策调用。 */
    private abort: AbortController | null = null

    /**
     * @param ctx - 浏览器插件上下文，其 `remote.credentials` 命名空间应答凭据读写。
     */
    constructor(private readonly ctx: ClientContext) {
        const scope = ctx.configForms.get<Record<string, unknown>>(CONFIG_NS) as SettingsFormScope<Record<string, unknown>>
        this.form = new SettingsFormModel(scope, [
            baseURLField,
            booleanField('fullURL'),
            authHeaderField,
            settingsTextField('model'),
            contextTokensField,
            toolWhitelistField,
            thresholdField,
            presetField('onSessionReset'),
            presetField('onApiUnavailable'),
            booleanField('notifyOnFallback'),
        ], [{ field: 'apiKey', write: text => this.writeKey(text) }])
        this.store = createSnapshotStore(this.projection())
        this.disposers.push(this.form.bind(() => this.form.shell()).subscribe(() => { this.publish() }))
        this.disposers.push(scope.subscribe(() => { this.publish() }))
        this.disposers.push(ctx.remote.$on('credentials/reference-updated', (ref: string) => {
            if (ref === CREDENTIAL_REF) void this.readCredential()
        }))
        void this.readCredential()
    }

    /** 组装当前快照。 */
    private projection(): CardState {
        const baseURL = this.form.field('baseURL')
        const model = this.form.field('model')
        const apiKey = this.form.field('apiKey')
        return {
            ...this.form.shell(),
            baseURL,
            fullURL: draftBoolean(this.form.field('fullURL').text),
            authHeader: this.form.field('authHeader'),
            model,
            contextTokens: this.form.field('contextTokens'),
            toolWhitelist: this.form.field('toolWhitelist'),
            toolWhitelistCount: parseToolWhitelist(this.form.field('toolWhitelist').text).length,
            confidenceThreshold: this.form.field('confidenceThreshold'),
            onSessionReset: this.form.field('onSessionReset').text,
            onApiUnavailable: this.form.field('onApiUnavailable').text,
            notifyOnFallback: draftBoolean(this.form.field('notifyOnFallback').text),
            apiKey,
            apiKeyConfigured: this.credential.configured,
            apiKeyWritable: this.credential.writable,
            testable: baseURL.text.trim() !== ''
                && (apiKey.text.trim() !== '' || this.credential.configured),
            test: this.single,
            testDouble: this.double,
            lastTest: this.lastTest,
            stats: this.stats,
        }
    }

    /** 发布新快照。 */
    private publish(): void {
        this.store.set(this.projection())
    }

    /** 读取凭据状态。 */
    private async readCredential(): Promise<void> {
        const response = await this.ctx.remote.credentials.describe([CREDENTIAL_REF])
        if (!response.ok) return
        const view = response.value[CREDENTIAL_REF]
        this.credential = { configured: view?.configured ?? false, writable: view?.writable ?? true }
        this.publish()
    }

    /**
     * 写入密钥，再回读确认。
     * @param value - 用户输入的密钥。
     * @returns 宿主是否报告已配置。
     */
    private async writeKey(value: string): Promise<boolean> {
        await this.ctx.remote.credentials.set(CREDENTIAL_REF, value)
        await this.readCredential()
        return this.credential.configured
    }

    /**
     * 构造注入面。
     * @returns 快照与动作。
     */
    inject(): CardFace {
        const actions = this.form.actions()
        return {
            hooks: { card: this.store },
            edit: (field, text) => { this.clearOutcome(); actions.edit(field, text) },
            resetField: (field) => { this.clearOutcome(); actions.resetField(field) },
            save: actions.save,
            discard: actions.discard,
            setPreset: (field, value) => { actions.edit(field, value) },
            setFullURL: (value) => { this.clearOutcome(); actions.edit('fullURL', String(value)) },
            setNotify: (value) => { actions.edit('notifyOnFallback', String(value)) },
            test: () => { void this.runTest() },
            testDouble: () => { void this.runDoubleTest() },
            refreshStats: () => { void this.readStats() },
            resetTest: () => { this.clearOutcome() },
        }
    }

    /** 作废上次结果：改了配置，旧结论不再对应当前输入；在途请求一并中止并丢弃。 */
    private clearOutcome(): void {
        this.abort?.abort()
        this.abort = null
        this.runId += 1
        if (this.single === null && this.double === null && this.lastTest === null) return
        this.single = null
        this.double = null
        this.lastTest = null
        this.publish()
    }

    /** 读取审查状态统计；路由不可用或载荷不合法时保留上一次结果。 */
    private async readStats(): Promise<void> {
        try {
            const response = await fetch(STATS_URL, { signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS) })
            if (!response.ok) return
            const stats = parseStats(await response.json())
            if (stats === undefined) return
            this.stats = stats
            this.publish()
        } catch {
        }
    }

    /** 开始一次测试：作废旧结果，新建中止器，并记下本次类别与代号供返回时校验。 */
    private beginTest(kind: TestKind): { runId: number; signal: AbortSignal } {
        this.runId += 1
        this.abort = new AbortController()
        this.lastTest = kind
        if (kind === 'single') this.single = { kind: 'running' }
        else this.double = { kind: 'running' }
        this.publish()
        return { runId: this.runId, signal: this.abort.signal }
    }

    /** 连通性测试：把当前草稿配置交给宿主发一次最小请求。 */
    private async runTest(): Promise<void> {
        const state = this.store.getSnapshot()
        if (state.baseURL.text.trim() === '' || state.contextTokens.invalid) return
        const run = this.beginTest('single')
        const outcome = await probeEndpoint({
            baseURL: state.baseURL.text.trim(),
            fullURL: state.fullURL,
            authHeader: state.authHeader.text,
            model: state.model.text.trim(),
            apiKey: state.apiKey.text.trim(),
        }, run.signal)
        if (run.runId !== this.runId) return
        this.single = outcome
        this.publish()
        void this.readStats()
    }

    /** 双发测试：按上下文窗口填满请求发两次。 */
    private async runDoubleTest(): Promise<void> {
        const state = this.store.getSnapshot()
        if (state.baseURL.text.trim() === '' || state.contextTokens.invalid) return
        const run = this.beginTest('double')
        const outcome = await probeEndpoint({
            baseURL: state.baseURL.text.trim(),
            fullURL: state.fullURL,
            authHeader: state.authHeader.text,
            model: state.model.text.trim(),
            apiKey: state.apiKey.text.trim(),
            contextTokens: parseContextTokens(state.contextTokens.text) ?? DEFAULT_CONFIG.contextTokens,
        }, run.signal)
        if (run.runId !== this.runId) return
        this.double = outcome
        this.publish()
        void this.readStats()
    }

    /** 释放订阅。 */
    dispose(): void {
        for (const off of this.disposers) off()
        this.form.dispose()
    }
}
