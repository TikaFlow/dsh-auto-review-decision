/**
 * 配置卡片的样式层：内嵌样式表 + 幂等注入。
 *
 * 色值只用宿主 `--dsw-alias-*` 令牌；外壳与控件几何复刻宿主插件卡与 settings-form。
 *
 * @module dsh-auto-review-decision/client/styles
 */

/** 样式标签 id。 */
const STYLE_ID = 'dsh-ar-decision-css'

/** 内嵌样式表（`dsh-ar-` 前缀防撞）。 */
const STYLE_TEXT = [
    '.dsh-ar-card{list-style:none;border:0.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:16px;background:var(--dsw-alias-bg-layer-3,#fff)}',
    '.dsh-ar-card:hover{border-color:var(--dsw-alias-label-dimmed,#e1e5ee)}',
    '.dsh-ar-cardOpen{border-color:var(--dsw-alias-label-dimmed,#e1e5ee);background:var(--dsw-alias-bg-layer-2,#fff)}',
    '.dsh-ar-header{display:flex;align-items:center;gap:12px;box-sizing:border-box;width:100%;padding:12px 16px;border:1px solid transparent;border-radius:12px;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer}',
    '.dsh-ar-headText{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}',
    '.dsh-ar-name{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary,#0f1115)}',
    '.dsh-ar-desc{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#81858c)}',
    '.dsh-ar-chevron{flex:none;color:var(--dsw-alias-label-tertiary,#81858c);transition:transform .16s}',
    '.dsh-ar-chevronOpen{transform:rotate(180deg)}',
    '.dsh-ar-body{margin:0 16px;padding:0 0 8px}',
    '.dsh-ar-line{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#81858c)}',
    // 纵向间距只由 .dsh-ar-item 的 margin 承担；每行自有容器，宿主字段自带 padding 一律清零
    '.dsh-ar-item{margin:0;padding:0}',
    '.dsh-ar-item>*{margin:0}',
    '.dsh-ar-item+*{margin-top:16px}',
    '.dsh-ar-item+*>*{margin-top:0}',
    '.dsh-ar-flat{display:flex;flex-direction:column}',
    '.dsh-ar-row{display:flex;align-items:center;justify-content:space-between;gap:8px}',
    '.dsh-ar-rowText{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}',
    '.dsh-ar-rowTitle{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary,#0f1115)}',
    '.dsh-ar-rowDesc{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#81858c)}',
    '.dsh-ar-selector{display:inline-flex;align-items:center;gap:8px;height:34px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-3,#fff);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,#0f1115);cursor:pointer}',
    '.dsh-ar-selector:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary,rgb(65,118,230))}',
    '.dsh-ar-selector:disabled{color:var(--dsw-alias-label-tertiary,#81858c);cursor:default}',
    '.dsh-ar-selector:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary,rgb(65,118,230))}',
    '.dsh-ar-toggle{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,#0f1115)}',
    // 组标题：顶部 16px 间距 + 分隔线，与其后一行再隔 16px
    '.dsh-ar-group{margin:16px 0 0;padding:16px 0 0;border-top:0.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));font-size:12px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-tertiary,#81858c)}',
    '.dsh-ar-group+.dsh-ar-item{margin-top:16px}',
    '.dsh-ar-actions{display:flex;justify-content:flex-start;gap:8px}',
    '.dsh-ar-pills{display:flex;justify-content:flex-start;flex-wrap:wrap;gap:8px}',
    '.dsh-ar-test{flex:none;appearance:none;border:1px solid transparent;border-radius:var(--dsw-radius-md,12px);padding:5px 14px;background:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-bg-layer-3,#fff);cursor:pointer}',
    '.dsh-ar-test:hover:not(:disabled){opacity:.88}',
    '.dsh-ar-test:disabled{opacity:.4;cursor:default}',
    '.dsh-ar-test:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,rgb(65,118,230)));outline-offset:1px}',
    // 测试结果的独立一行：字号与宿主字段提示同规格，配色随三态变
    '.dsh-ar-testNote{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#81858c)}',
    '.dsh-ar-testNote-note{color:var(--dsw-alias-label-tertiary,#81858c)}',
    '.dsh-ar-testNote-passed{color:var(--dsw-alias-state-success,#16a34a)}',
    '.dsh-ar-testNote-failed{color:var(--dsw-alias-state-error,#e5484d)}',
    // 间距只由 .dsh-ar-item 提供
    '.dsh-ar-item div[class*="field"]{padding:0;border-top:none}',
    // 覆盖宿主 footer 只有 padding-top 的默认，保存按钮上方补分隔线
    '.dsh-ar-body form>div:last-child,.dsh-ar-body>div>div:last-child{border-top:0.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}',
].join('\n')

/** 幂等注入样式：节点在则同步内容。 */
export function ensureStyles(): void {
    if (typeof document === 'undefined') return
    let tag = document.getElementById(STYLE_ID)
    if (tag === null) {
        tag = document.createElement('style')
        tag.id = STYLE_ID
        tag.dataset.plugin = 'dsh-auto-review-decision'
        document.head.appendChild(tag)
    }
    if (tag.textContent !== STYLE_TEXT) tag.textContent = STYLE_TEXT
}
