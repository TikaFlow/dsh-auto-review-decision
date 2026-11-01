import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { EXEMPT_TOOLS, whitelistVerdict } from '../src/whitelist.ts'

/** 会话工作区根。 */
const CWD = process.platform === 'win32' ? 'C:\\work' : '/work'

/** 委派工具：子级继承本预设并继续受审。 */
const DELEGATION_TOOLS = ['subagent', 'subagent_fork', 'workflow']

/** 半免审的写入工具：目标在工作区内才放行。 */
const WRITE_TOOLS = ['write', 'edit']

/** 构造一个只暴露 `resolve` / `contains` 的假文件系统。 */
function fakeFs(files: ReadonlySet<string>): Context {
    return {
        get: () => ({
            resolve: async (path: string) => path,
            contains: (parent: string, child: string) => files.has(child) && child.startsWith(parent),
        }),
    } as unknown as Context
}

/** 构造一个最小的待审调用。 */
function exec(name: string, args: unknown): ToolExecution {
    return { name, arguments: args } as unknown as ToolExecution
}

test('完全免审工具直接放行', async () => {
    for (const name of EXEMPT_TOOLS) {
        const verdict = await whitelistVerdict(fakeFs(new Set()), exec(name, {}), CWD, new AbortController().signal)
        assert.deepEqual(verdict, { kind: 'allow' }, name)
    }
})

test('白名单外工具一律送审', async () => {
    for (const name of ['pwsh', 'terminal_send', 'mcp__keen__search_web_pages']) {
        const verdict = await whitelistVerdict(fakeFs(new Set()), exec(name, {}), CWD, new AbortController().signal)
        assert.equal(verdict, undefined, name)
    }
})

test('子级预设非无限制的委派免审', async () => {
    for (const name of DELEGATION_TOOLS) {
        for (const args of [{}, { prompt: 'x' }, { agent_preset: 'read-only' }, { agent_preset: 'workspace-write' }]) {
            const verdict = await whitelistVerdict(fakeFs(new Set()), exec(name, args), CWD, new AbortController().signal)
            assert.deepEqual(verdict, { kind: 'allow' }, `${name} ${JSON.stringify(args)}`)
        }
    }
})

test('子级预设为无限制的委派仍送审', async () => {
    for (const name of DELEGATION_TOOLS) {
        const verdict = await whitelistVerdict(
            fakeFs(new Set()), exec(name, { agent_preset: 'danger-full-access' }), CWD, new AbortController().signal)
        assert.equal(verdict, undefined, name)
    }
})

test('只读取工作目录的调用免审', async () => {
    const verdict = await whitelistVerdict(fakeFs(new Set()), exec('working_directory', {}), CWD, new AbortController().signal)
    assert.deepEqual(verdict, { kind: 'allow' })
})

test('改变工作目录的调用仍送审', async () => {
    const outside = process.platform === 'win32' ? 'C:\\secret' : '/secret'
    const verdict = await whitelistVerdict(
        fakeFs(new Set()), exec('working_directory', { cd: outside }), CWD, new AbortController().signal)
    assert.equal(verdict, undefined)
})

test('工作区内的写入免审', async () => {
    const inside = process.platform === 'win32' ? 'C:\\work\\a.ts' : '/work/a.ts'
    const fs = fakeFs(new Set([CWD, inside]))
    for (const name of WRITE_TOOLS) {
        const verdict = await whitelistVerdict(fs, exec(name, { file_path: inside }), CWD, new AbortController().signal)
        assert.deepEqual(verdict, { kind: 'allow' }, name)
    }
})

test('工作区外的写入仍送审', async () => {
    const outside = process.platform === 'win32' ? 'C:\\secret\\k.txt' : '/secret/k.txt'
    const fs = fakeFs(new Set([CWD, outside]))
    for (const name of WRITE_TOOLS) {
        const verdict = await whitelistVerdict(fs, exec(name, { file_path: outside }), CWD, new AbortController().signal)
        assert.equal(verdict, undefined, name)
    }
})

test('缺少路径参数时送审', async () => {
    const fs = fakeFs(new Set([CWD]))
    for (const args of [{}, { file_path: '' }, { file_path: 42 }]) {
        const verdict = await whitelistVerdict(fs, exec('write', args), CWD, new AbortController().signal)
        assert.equal(verdict, undefined)
    }
})

test('解析失败时退回审查', async () => {
    const ctx = {
        get: () => ({
            resolve: async () => { throw new Error('ENOENT') },
            contains: () => true,
        }),
    } as unknown as Context
    const verdict = await whitelistVerdict(ctx, exec('write', { file_path: '/x' }), CWD, new AbortController().signal)
    assert.equal(verdict, undefined)
})

test('文件系统服务缺失时退回审查', async () => {
    const ctx = { get: () => undefined } as unknown as Context
    const verdict = await whitelistVerdict(ctx, exec('write', { file_path: '/x' }), CWD, new AbortController().signal)
    assert.equal(verdict, undefined)
})

test('用户白名单命中的工具直接放行', async () => {
    // pwsh 不在内置免审表，也无半免审校验器：只有用户白名单能放行它。
    const verdict = await whitelistVerdict(
        fakeFs(new Set()), exec('pwsh', {}), CWD, new AbortController().signal, new Set(['pwsh', 'read']))
    assert.deepEqual(verdict, { kind: 'allow' })
})

test('用户白名单未命中的工具仍送审', async () => {
    const verdict = await whitelistVerdict(
        fakeFs(new Set()), exec('terminal_send', {}), CWD, new AbortController().signal, new Set(['pwsh']))
    assert.equal(verdict, undefined)
})
