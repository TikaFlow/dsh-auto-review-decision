/**
 * 配置卡片：复刻宿主插件卡的可折叠外壳，正文为配置、判定与降级三组设置。
 *
 * @module dsh-auto-review-decision/client/card
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsHooks } from '@deepseek-ai/dsh-client-ui-slots'
import type { CardFace } from './controller.ts'
import { ensureStyles } from './styles.ts'
import type { CardLocaleKey } from './locale.ts'
import { presetName } from './preset-labels.ts'
import { DEFAULT_CONFIG, PRESET_OPTIONS } from '../shared/config.ts'

const {
    IconChevronDownOutlineRegular, Menu, SettingsForm, SettingsSecretField, SettingsValueField, Switch,
} = primitives

/** 卡片完整 props：`hooks.card` 由渲染器绑定为 `useCard`。 */
export type CardProps = Omit<CardFace, 'hooks'> & PropsHooks<CardFace['hooks']> & {
    /** 文案查询。 */
    readonly t: (key: CardLocaleKey) => string
    /** 初始是否展开。 */
    readonly defaultOpen?: boolean
}

/** 一个设置行：自有容器承担纵向间距，屏蔽宿主字段自带的 padding。 */
function Row(props: { readonly children: ReactNode }): JSX.Element {
    return <div className="dsh-ar-item">{props.children}</div>
}

/** 预设选择行。 */
function PresetRow(props: {
    readonly label: string
    readonly value: string
    readonly fallback: string
    readonly disabled: boolean
    readonly onChange: (value: string) => void
    readonly t: (key: CardLocaleKey) => string
}): JSX.Element {
    const [open, setOpen] = useState(false)
    const labelOf = (value: string): string => presetName(value === '' ? props.fallback : value, props.t)
    return (
        <div className="dsh-ar-row">
            <div className="dsh-ar-rowText">
                <span className="dsh-ar-rowTitle">{props.label}</span>
            </div>
            <Menu
                open={open}
                onClose={() => { setOpen(false) }}
                items={PRESET_OPTIONS.map(value => ({ id: value, label: labelOf(value) }))}
                selectedId={props.value}
                onSelect={(id) => {
                    setOpen(false)
                    if (id !== props.value) props.onChange(id)
                }}
                align="end"
                portal
                anchor={(
                    <button
                        type="button"
                        className="dsh-ar-selector"
                        aria-haspopup="menu"
                        aria-expanded={open}
                        aria-label={props.label}
                        disabled={props.disabled}
                        onClick={() => { setOpen(value => !value) }}
                    >
                        {labelOf(props.value)}
                        <IconChevronDownOutlineRegular className="dsh-ar-chevron" />
                    </button>
                )}
            />
        </div>
    )
}

/**
 * 渲染配置卡片。
 * @param props - 快照选择器、动作与文案。
 * @returns 卡片。
 */
export function Card(props: CardProps) {
    useEffect(() => { ensureStyles(); return props.resetTest }, [])
    const state = props.useCard(snapshot => snapshot)
    const { t } = props
    const [open, setOpen] = useState(props.defaultOpen ?? true)
    const disabled = !state.writable || state.saving

    const test = state.test
    const testNote = test === null
        ? { tone: 'note', text: t('testHint') }
        : test.kind === 'running'
            ? { tone: 'note', text: t('testing') }
            : test.kind === 'passed'
                ? { tone: 'passed', text: t('testPassed') }
                : { tone: 'failed', text: test.message }
    const testNoteClass = {
        note: 'dsh-ar-testNote dsh-ar-testNote-note',
        passed: 'dsh-ar-testNote dsh-ar-testNote-passed',
        failed: 'dsh-ar-testNote dsh-ar-testNote-failed',
    }[testNote.tone]

    return (
        <div className={open ? 'dsh-ar-card dsh-ar-cardOpen' : 'dsh-ar-card'}>
            <button
                type="button"
                className="dsh-ar-header"
                aria-expanded={open}
                aria-label={t('title')}
                onClick={() => { setOpen(!open) }}
            >
                <span className="dsh-ar-headText">
                    <span className="dsh-ar-name">{t('title')}</span>
                    <span className="dsh-ar-desc">{t('description')}</span>
                </span>
                <IconChevronDownOutlineRegular className={open ? 'dsh-ar-chevron dsh-ar-chevronOpen' : 'dsh-ar-chevron'} />
            </button>
            {open
                ? (
                    <div className="dsh-ar-body">
                        <SettingsForm
                            labels={{
                                unavailable: t('unavailable'),
                                readOnly: t('readOnly'),
                                saveFailed: t('saveFailed'),
                                save: t('save'),
                                saving: t('saving'),
                            }}
                            state={state}
                            onSave={props.save}
                            onDiscard={props.discard}
                        >
                            <div className="dsh-ar-flat">
                                <p className="dsh-ar-group">{t('config')}</p>
                                <Row>
                                    <SettingsValueField
                                        id="dsh-ar-base-url"
                                        label={t('baseURL')}
                                        hint={state.fullURL ? t('baseURLHintFull') : t('baseURLHint')}
                                        overriddenLabel={t('overridden')}
                                        resetLabel={t('reset')}
                                        invalidLabel={t('invalidURL')}
                                        disabled={disabled}
                                        {...state.baseURL}
                                        onEdit={text => { props.edit('baseURL', text) }}
                                        onReset={() => { props.resetField('baseURL') }}
                                    />
                                </Row>
                                <Row>
                                    <label className="dsh-ar-toggle">
                                        <span>{t('fullURL')}</span>
                                        <Switch
                                            checked={state.fullURL}
                                            label={t('fullURL')}
                                            disabled={disabled}
                                            onChange={value => { props.setFullURL(value) }}
                                        />
                                    </label>
                                </Row>
                                <Row>
                                    <SettingsSecretField
                                        id="dsh-ar-api-key"
                                        label={t('apiKey')}
                                        hint={t('apiKeyHint')}
                                        disabled={!state.apiKeyWritable}
                                        text={state.apiKey.text}
                                        configured={state.apiKeyConfigured}
                                        stateLabel={state.apiKeyConfigured ? t('apiKeySet') : t('apiKeyUnset')}
                                        onEdit={text => { props.edit('apiKey', text) }}
                                    />
                                </Row>
                                <Row>
                                    <SettingsValueField
                                        id="dsh-ar-model"
                                        label={t('model')}
                                        hint={t('modelHint')}
                                        overriddenLabel={t('overridden')}
                                        resetLabel={t('reset')}
                                        invalidLabel=''
                                        disabled={disabled}
                                        {...state.model}
                                        onEdit={text => { props.edit('model', text) }}
                                        onReset={() => { props.resetField('model') }}
                                    />
                                </Row>
                                <Row>
                                    <SettingsValueField
                                        id="dsh-ar-context-tokens"
                                        label={t('contextTokens')}
                                        hint={t('contextTokensHint')}
                                        overriddenLabel={t('overridden')}
                                        resetLabel={t('reset')}
                                        invalidLabel={t('invalidContextTokens')}
                                        placeholder="24K"
                                        disabled={disabled}
                                        {...state.contextTokens}
                                        onEdit={text => { props.edit('contextTokens', text) }}
                                        onReset={() => { props.resetField('contextTokens') }}
                                    />
                                </Row>
                                <Row>
                                    <div className="dsh-ar-actions">
                                        <button
                                            type="button"
                                            className="dsh-ar-test"
                                            disabled={disabled || !state.testable || test?.kind === 'running'}
                                            onClick={props.test}
                                        >
                                            {test?.kind === 'running' ? t('testing') : t('test')}
                                        </button>
                                        <button
                                            type="button"
                                            className="dsh-ar-test"
                                            disabled={disabled || !state.testable || test?.kind === 'running'}
                                            onClick={props.testDouble}
                                        >
                                            {test?.kind === 'running' ? t('testing') : t('testDouble')}
                                        </button>
                                    </div>
                                </Row>
                                <Row>
                                    <p className={testNoteClass} role="status">{testNote.text}</p>
                                </Row>
                            </div>
                            <p className="dsh-ar-group">{t('judgement')}</p>
                            <Row>
                                <SettingsValueField
                                    id="dsh-ar-threshold"
                                    label={t('confidenceThreshold')}
                                    hint={t('confidenceThresholdHint')}
                                    overriddenLabel={t('overridden')}
                                    resetLabel={t('reset')}
                                    invalidLabel={t('invalidNumber')}
                                    numeric
                                    disabled={disabled}
                                    {...state.confidenceThreshold}
                                    onEdit={text => { props.edit('confidenceThreshold', text) }}
                                    onReset={() => { props.resetField('confidenceThreshold') }}
                                />
                            </Row>
                            <Row>
                                <SettingsValueField
                                    id="dsh-ar-tool-whitelist"
                                    label={t('toolWhitelist')}
                                    hint={t('toolWhitelistHint').replace('{count}', String(state.toolWhitelistCount))}
                                    overriddenLabel={t('overridden')}
                                    resetLabel={t('reset')}
                                    invalidLabel=''
                                    disabled={disabled}
                                    {...state.toolWhitelist}
                                    onEdit={text => { props.edit('toolWhitelist', text) }}
                                    onReset={() => { props.resetField('toolWhitelist') }}
                                />
                            </Row>
                            <p className="dsh-ar-group">{t('fallback')}</p>
                            <Row>
                                <PresetRow
                                    label={t('onSessionReset')}
                                    value={state.onSessionReset}
                                    fallback={DEFAULT_CONFIG.onSessionReset}
                                    disabled={disabled}
                                    onChange={value => { props.setPreset('onSessionReset', value) }}
                                    t={t}
                                />
                            </Row>
                            <Row>
                                <PresetRow
                                    label={t('onApiUnavailable')}
                                    value={state.onApiUnavailable}
                                    fallback={DEFAULT_CONFIG.onApiUnavailable}
                                    disabled={disabled}
                                    onChange={value => { props.setPreset('onApiUnavailable', value) }}
                                    t={t}
                                />
                            </Row>
                            <Row>
                                <label className="dsh-ar-toggle">
                                    <span>{t('notifyOnFallback')}</span>
                                    <Switch
                                        checked={state.notifyOnFallback}
                                        label={t('notifyOnFallback')}
                                        disabled={disabled}
                                        onChange={value => { props.setNotify(value) }}
                                    />
                                </label>
                            </Row>
                            <p className="dsh-ar-group">{t('advanced')}</p>
                            <Row>
                                <SettingsValueField
                                    id="dsh-ar-auth-header"
                                    label={t('authHeader')}
                                    hint={t('authHeaderHint')}
                                    overriddenLabel={t('overridden')}
                                    resetLabel={t('reset')}
                                    invalidLabel={t('invalidAuthHeader')}
                                    placeholder="!x-api-key"
                                    disabled={disabled}
                                    {...state.authHeader}
                                    onEdit={text => { props.edit('authHeader', text) }}
                                    onReset={() => { props.resetField('authHeader') }}
                                />
                            </Row>
                        </SettingsForm>
                    </div>
                )
                : null}
        </div>
    )
}
