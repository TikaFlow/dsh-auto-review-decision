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
    CONFIG_NS,
    CREDENTIAL_REF,
    MAX_CONFIDENCE_THRESHOLD,
    MIN_CONFIDENCE_THRESHOLD,
    PRESET_OPTIONS,
    REVIEW_TIMEOUT_MS,
    TEST_URL,
    baseURLProblem,
} from '../shared/config.ts'
import { isRecord } from '../shared/tools.ts'

/** 一次连通性测试的结果；成功不带细节。 */
export type TestOutcome = {
    readonly kind: 'passed'
} | {
    readonly kind: 'failed'
    /** 失败原因，展示在结果行。 */
    readonly message: string
}

/** 测试状态；null 为未测过。 */
export type TestState = {
    readonly kind: 'running'
} | TestOutcome | null

/** 卡片上一次测试的载体。 */
interface EndpointProbe {
    readonly baseURL: string
    readonly fullURL: boolean
    readonly model: string
    readonly apiKey: string
}

/**
 * 请求宿主按草稿配置发一次最小请求。
 * 密钥只送到宿主的测试路由，由它代发决策请求，浏览器不直连。
 * @returns 通过与否。
 */
async function probeEndpoint(probe: EndpointProbe): Promise<TestOutcome> {
    try {
        const response = await fetch(TEST_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(probe),
            signal: AbortSignal.timeout(REVIEW_TIMEOUT_MS),
        })
        if (!response.ok) {
            const reason = (await response.text().catch(() => '')).trim()
            return { kind: 'failed', message: reason === '' ? `auto-review: HTTP ${String(response.status)}` : reason }
        }
        const body: unknown = await response.json()
        if (!isRecord(body)) return { kind: 'failed', message: 'auto-review: 连通性测试的响应不合法' }
        if (body.ok !== true) {
            return { kind: 'failed', message: typeof body.message === 'string' ? body.message : 'auto-review: 连通性测试失败' }
        }
        return { kind: 'passed' }
    } catch (error: unknown) {
        if (error instanceof Error && error.message !== '') return { kind: 'failed', message: `auto-review: ${error.message}` }
        return { kind: 'failed', message: 'auto-review: 连通性测试失败' }
    }
}

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
    /** 模型字段。 */
    readonly model: SettingsFieldState
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
    /** 连通性测试的状态。 */
    readonly test: TestState
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
    private outcome: TestState = null

    /**
     * @param ctx - 浏览器插件上下文，其 `remote.credentials` 命名空间应答凭据读写。
     */
    constructor(private readonly ctx: ClientContext) {
        const scope = ctx.configForms.get<Record<string, unknown>>(CONFIG_NS) as SettingsFormScope<Record<string, unknown>>
        this.form = new SettingsFormModel(scope, [
            baseURLField,
            booleanField('fullURL'),
            settingsTextField('model'),
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
            model,
            confidenceThreshold: this.form.field('confidenceThreshold'),
            onSessionReset: this.form.field('onSessionReset').text,
            onApiUnavailable: this.form.field('onApiUnavailable').text,
            notifyOnFallback: draftBoolean(this.form.field('notifyOnFallback').text),
            apiKey,
            apiKeyConfigured: this.credential.configured,
            apiKeyWritable: this.credential.writable,
            testable: baseURL.text.trim() !== ''
                && (apiKey.text.trim() !== '' || this.credential.configured),
            test: this.outcome,
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
            resetTest: () => { this.clearOutcome() },
        }
    }

    /** 作废上次结果：改了配置，旧结论不再对应当前输入。 */
    private clearOutcome(): void {
        if (this.outcome === null) return
        this.outcome = null
        this.publish()
    }

    /** 连通性测试：把当前草稿配置交给宿主发一次最小请求。 */
    private async runTest(): Promise<void> {
        const state = this.store.getSnapshot()
        if (state.baseURL.text.trim() === '') return
        this.outcome = { kind: 'running' }
        this.publish()
        const outcome = await probeEndpoint({
            baseURL: state.baseURL.text.trim(),
            fullURL: state.fullURL,
            model: state.model.text.trim(),
            apiKey: state.apiKey.text.trim(),
        })
        this.outcome = outcome
        this.publish()
    }

    /** 释放订阅。 */
    dispose(): void {
        for (const off of this.disposers) off()
        this.form.dispose()
    }
}
