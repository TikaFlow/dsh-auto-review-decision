# AGENTS.md

## 项目

DSH 插件：以 SystemOne 决策接口审查每次工具调用，服务于仅在当前会话生效的 `auto` 权限预设。

派生自 `deepseek-ai/deepseek-harness` 的 `packages/experimental/auto-review`，后端替换为 SystemOne。

## 命令

- `pnpm build` — `tsc -p tsconfig.build.json && tsdown`
- `pnpm typecheck` — `tsc --noEmit`
- 无测试脚本；用例在 `tests/`（`*.spec.ts` / `*.test.ts` / `*.e2e.ts`）。

## 结构

Node 半与浏览器半分离：`src/*` 进 `lib/index.js`，`src/client/*` 进 `lib/client.js`。`src/shared/*` 两半共用，零宿主依赖。

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件入口：`name` / `inject` / `Config` / `apply` |
| `src/lifecycle.ts` | 闸门接线：`tools/pre-execute` 前置审查、Auto 预设注册、卸载排空 |
| `src/reviewer.ts` | 审查主体：凭据、工作目录、快照、请求、判定 |
| `src/snapshot.ts` | 从会话日志冻结审查输入 |
| `src/roles.ts` | 会话条目来源角色归类 |
| `src/steps.ts` | 回合/步骤身份与作用域键 |
| `src/log.ts` | 会话日志读取工具 |
| `src/args-schema.ts` | 参数本地预检（JSON Schema 子集） |
| `src/whitelist.ts` | 内置白名单：免审工具与工作区内读取 |
| `src/questions.ts` | 问题表判定规则 |
| `src/systemone.ts` | 决策接口线协议类型 |
| `src/systemone-client.ts` | 决策接口 HTTP 调用与响应校验 |
| `src/verdict.ts` | 结论落地为工具流水线决定 |
| `src/fallback.ts` | 连续失败降级与提示推送 |
| `src/session-exit.ts` | Auto 会话退出去向 |
| `src/config.ts` | 配置 schema 与加载期校验 |
| `src/locales.ts` | 审查理由与提示文案 |
| `src/shared/config.ts` | 配置常量与纯函数（两半共用） |
| `src/shared/questions.ts` | 问题 id、问法、因子（纯数据） |
| `src/client/*` | 设置卡片：控制器、样式、文案、预设名 |
| `locale/*.json` | 中英文案 |
| `docs/systemone-protocol.md` | 决策接口协议 |

## 约束

- `src/shared/*` 不得导入宿主包，否则浏览器半失效。
- `REVIEW_POLICY`（`reviewer.ts`）是模型侧协议文本，措辞变化即改变审查行为。
- 审查请求只发往决策端点，不写入会话日志。
- 配置项全为 `.volatile()`，改完下次审查即生效。
- 响应校验不 clamp 越界值；任一卫语句失败一律 `deny`。
- 白名单在参数预检之后判定：免审调用仍须通过契约校验。
- 凭据走宿主凭据管理（`TIKAFLOW_SYSTEMONE_API_KEY`），不得硬编码或回显。

## 偏好

- 缩进 4 空格，UTF-8 无 BOM，LF。
- 类型导入用 `import type`；相对导入带 `.ts` 后缀。
- 注释写行为契约与非常规约束，不写推导过程。
