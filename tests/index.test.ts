/**
 * 统一测试入口：集中导入全部测试文件，`pnpm test` 编译后在同一 node 进程内执行
 * （`node .test-dist/tests/index.test.js`）。
 *
 * 编译产物会按 const enum 语义内联 src 与依赖中的常量枚举（如 cordis 的 FiberState），
 * 闸门层用例（tests/lifecycle.test.ts）经此获得与构建产物一致的运行时。
 *
 * 本文件只作为入口被 test 脚本执行，不承载用例，也不被其他测试文件导入。
 * 用例不得依赖文件导入顺序：触碰环境配置的文件须在用例内设置并在结束后还原。
 *
 * @module tests/index
 */

import { Context } from '@deepseek-ai/cordis'
import { applyFallback } from '../src/stats.ts'
import './args-schema.test.ts'
import './auth-header.test.ts'
import './budget.test.ts'
import './context-window.test.ts'
import './endpoint.test.ts'
import './fallback-route.test.ts'
import './fixed-overhead.test.ts'
import './history.test.ts'
import './lifecycle.test.ts'
import './log.test.ts'
import './probe.test.ts'
import './questions.test.ts'
import './retry.test.ts'
import './reviewer.test.ts'
import './roles.test.ts'
import './session-exit.test.ts'
import './snapshot.test.ts'
import './stats.test.ts'
import './steps.test.ts'
import './systemone-client.test.ts'
import './tool-whitelist.test.ts'
import './verdict.test.ts'
import './whitelist.test.ts'

// 请求链路无条件记账：进程内先初始化统计存储，避免第一条用例写入前存储尚未创建。
applyFallback(new Context())
