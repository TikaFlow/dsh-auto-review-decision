/**
 * 配置卡片：复刻宿主插件卡的可折叠外壳，正文为连接与降级两组设置。
 *
 * @module dsh-auto-review-systemOne/client/card
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsHooks } from '@deepseek-ai/dsh-client-ui-slots'
import type { CardFace } from './controller.ts'
import { ensureStyles } from './styles.ts'
import type { CardLocaleKey } from './locale.ts'
import { PRESET_OPTIONS } from '../shared/config.ts'

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

/** 预设机器值 → 文案键。 */
const PRESET_LABELS: Readonly<Record<string, CardLocaleKey>> = {
    'read-only': 'presetReadOnly',
    'workspace-write': 'presetWorkspaceWrite',
    'danger-full-access': 'presetFullAccess',
}

/** 预设选择行。 */
function PresetRow(props: {
    readonly label: string
    readonly value: string
    readonly disabled: boolean
    readonly onChange: (value: string) => void
    readonly t: (key: CardLocaleKey) => string
}): JSX.Element {
    const [open, setOpen] = useState(false)
    const labelOf = (value: string): string => {
        const key = PRESET_LABELS[value]
        return key === undefined ? value : props.t(key)
    }
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
    useEffect(() => { ensureStyles() }, [])
    const state = props.useCard(snapshot => snapshot)
    const { t } = props
    const [open, setOpen] = useState(props.defaultOpen ?? true)
    const disabled = !state.writable || state.saving

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
                                <SettingsValueField
                                    id="dsh-ar-base-url"
                                    label={t('baseURL')}
                                    hint={t('baseURLHint')}
                                    overriddenLabel={t('overridden')}
                                    resetLabel={t('reset')}
                                    invalidLabel={t('invalidURL')}
                                    disabled={disabled}
                                    {...state.baseURL}
                                    onEdit={text => { props.edit('baseURL', text) }}
                                    onReset={() => { props.resetField('baseURL') }}
                                />
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
                                <SettingsValueField
                                    id="dsh-ar-model"
                                    label={t('model')}
                                    hint={t('modelHint')}
                                    overriddenLabel={t('overridden')}
                                    resetLabel={t('reset')}
                                    invalidLabel={t('invalidModel')}
                                    disabled={disabled}
                                    {...state.model}
                                    onEdit={text => { props.edit('model', text) }}
                                    onReset={() => { props.resetField('model') }}
                                />
                                <div className="dsh-ar-actions">
                                    <button
                                        type="button"
                                        className="dsh-ar-test"
                                        disabled={disabled || !state.testable}
                                        onClick={props.test}
                                    >
                                        {t('test')}
                                    </button>
                                </div>
                            </div>
                            <p className="dsh-ar-group">{t('judgement')}</p>
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
                            <p className="dsh-ar-group">{t('fallback')}</p>
                            <PresetRow
                                label={t('onSessionReset')}
                                value={state.onSessionReset}
                                disabled={disabled}
                                onChange={value => { props.setPreset('onSessionReset', value) }}
                                t={t}
                            />
                            <PresetRow
                                label={t('onApiUnavailable')}
                                value={state.onApiUnavailable}
                                disabled={disabled}
                                onChange={value => { props.setPreset('onApiUnavailable', value) }}
                                t={t}
                            />
                            <label className="dsh-ar-toggle">
                                <span>{t('notifyOnFallback')}</span>
                                <Switch
                                    checked={state.notifyOnFallback}
                                    label={t('notifyOnFallback')}
                                    disabled={disabled}
                                    onChange={value => { props.setNotify(value) }}
                                />
                            </label>
                        </SettingsForm>
                    </div>
                )
                : null}
        </div>
    )
}
