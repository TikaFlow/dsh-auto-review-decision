/**
 * 浏览器半文案：中英双语。
 *
 * 字段标签与 `CONFIG_LABELS` 一致；权限模式名沿用宿主官方译名。
 *
 * @module dsh-auto-review-systemOne/client/locale
 */

/** 英文文案。 */
const en = {
    title: 'SystemOne review',
    description: 'Review every tool call with the SystemOne decision API.',
    baseURL: 'API address',
    baseURLHint: 'Without /systemone; the code appends it.',
    model: 'Model ID',
    modelHint: 'Model identifier used for the decision request.',
    apiKey: 'API key',
    apiKeyHint: 'Stored by the host credential store; never shown again.',
    apiKeySet: 'Configured',
    apiKeyUnset: 'Not configured',
    confidenceThreshold: 'Confidence threshold',
    confidenceThresholdHint: 'Higher is more conservative. 0.6–0.99.',
    judgement: 'Judgement',
    fallback: 'Fallback',
    onSessionReset: 'Permission mode on session reset',
    onApiUnavailable: 'Permission mode when the API is unavailable',
    notifyOnFallback: 'Notify the user on fallback',
    presetReadOnly: 'Read Only',
    presetWorkspaceWrite: 'Workspace Write',
    presetFullAccess: 'Full access',
    test: 'Test',
    fallbackNotice: 'SystemOne review failed repeatedly; this session switched to "{preset}".',
    unavailable: 'Configuration is not available.',
    readOnly: 'Configuration is read-only.',
    saveFailed: 'Save was not accepted.',
    save: 'Save',
    saving: 'Saving…',
    overridden: 'Overridden',
    reset: 'Reset',
    invalidNumber: 'Enter a number in range.',
    invalidURL: 'Enter an http(s) URL without /systemone.',
    invalidModel: 'Enter a model name.',
}

/** 中文文案。 */
const zh = {
    title: 'SystemOne 审查',
    description: '使用 SystemOne 决策接口审查每一次工具调用。',
    baseURL: 'API 地址',
    baseURLHint: '不含 /systemone，代码会自动追加。',
    model: '模型 ID',
    modelHint: '决策请求使用的模型标识。',
    apiKey: 'API 密钥',
    apiKeyHint: '由宿主凭据管理保存，之后不再回显。',
    apiKeySet: '已配置',
    apiKeyUnset: '未配置',
    confidenceThreshold: '置信度阈值',
    confidenceThresholdHint: '越高越保守，取值 0.6–0.99。',
    judgement: '判定',
    fallback: '降级去向',
    onSessionReset: '会话重置时的权限模式',
    onApiUnavailable: '接口不可用时的权限模式',
    notifyOnFallback: '降级时提示用户',
    presetReadOnly: '仅可查看',
    presetWorkspaceWrite: '工作区内修改',
    presetFullAccess: '完全权限',
    test: '测试',
    fallbackNotice: 'SystemOne 审查连续失败，本会话已切换到「{preset}」权限模式。',
    unavailable: '配置服务不可用。',
    readOnly: '配置为只读。',
    saveFailed: '保存未被接受。',
    save: '保存',
    saving: '保存中…',
    overridden: '已覆盖',
    reset: '重置',
    invalidNumber: '请输入范围内的数字。',
    invalidURL: '请输入不含 /systemone 的 http(s) 地址。',
    invalidModel: '请输入模型名。',
} satisfies typeof en

/** 文案表。 */
export const dictionaries = { zh, en }

/** 一条文案的键。 */
export type CardLocaleKey = keyof typeof en
