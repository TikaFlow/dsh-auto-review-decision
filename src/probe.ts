/**
 * 连通性测试：按卡片草稿向决策端点发一次最小请求，只回「通过 / 原因」。
 *
 * 走 `connection.fetch` 而非 `connection.rpc.handle`：后者求值 `owner.webServer`，
 * 而 connection 不声明 `webServer`。与审查分流：不入降级计数。
 *
 * @module dsh-auto-review-systemOne/probe
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { baseURLProblem, CREDENTIAL_REF, REVIEW_TIMEOUT_MS, TEST_ROUTE } from './shared/config.ts'
import { isRecord } from './shared/tools.ts'
import { postDecision, SystemOneCallError } from './systemone-client.ts'
import type { SystemOneRequest } from './systemone.ts'

/** 连通性测试的结果；成功不回细节。 */
export type ProbeResult = {
    readonly ok: true
} | {
    readonly ok: false
    /** 面向用户的失败原因。 */
    readonly message: string
}

/** 最小请求：余额 1152，问是否超过 1000。 */
const PROBE_REQUEST: SystemOneRequest = {
    state: 'The account balance is 1152.',
    questions: {
        balance: {
            type: 'noul',
            instructions: 'Is the balance greater than 1000?',
            criteria: { true: 'The balance exceeds 1000', false: 'The balance does not exceed 1000' },
        },
    },
}

/** 路由只认的载荷形状；字段非法一律按缺失处理。 */
interface ProbePayload {
    readonly baseURL: string
    readonly fullURL: boolean
    readonly model: string
    /** 卡片草稿里的密钥；空串表示改用已保存的凭据。 */
    readonly apiKey: string
}

/** 读出载荷里的字段；类型不符退回空值。 */
function readPayload(payload: unknown): ProbePayload {
    const record = isRecord(payload) ? payload : {}
    const text = (key: string): string => typeof record[key] === 'string' ? record[key] as string : ''
    return {
        baseURL: text('baseURL').trim(),
        fullURL: record.fullURL === true,
        model: text('model').trim(),
        apiKey: text('apiKey'),
    }
}

/** 取失败原因：本模块的错误自带可呈现文案。 */
function messageOf(error: unknown): string {
    if (error instanceof SystemOneCallError) return error.message
    if (error instanceof Error && error.message !== '') return `auto-review: ${error.message}`
    return 'auto-review: 连通性测试失败'
}

/** 解析凭据；未配置返回 undefined。 */
async function resolveKey(ctx: Context): Promise<string | undefined> {
    const credential = await ctx.credentials.resolve(credentialRef(CREDENTIAL_REF))
    return credential?.value
}

/**
 * 按草稿配置发一次探活请求。
 * @returns 通过与否。
 */
async function probe(ctx: Context, payload: unknown, signal: AbortSignal): Promise<ProbeResult> {
    const body = readPayload(payload)
    if (body.baseURL === '' || baseURLProblem(body.baseURL) !== undefined) {
        return { ok: false, message: 'auto-review: API 地址未填写或不合法；请检查「API 地址」' }
    }
    const apiKey = body.apiKey || await resolveKey(ctx)
    if (apiKey === undefined || apiKey === '') {
        return { ok: false, message: 'auto-review: 凭据未配置；请检查「API 密钥」' }
    }
    const timeout = AbortSignal.timeout(REVIEW_TIMEOUT_MS)
    try {
        await postDecision(PROBE_REQUEST, {
            baseURL: body.baseURL,
            fullURL: body.fullURL,
            model: body.model,
            apiKey,
            signal: AbortSignal.any([signal, timeout]),
        })
        return { ok: true }
    } catch (error: unknown) {
        return { ok: false, message: messageOf(error) }
    }
}

/** 注册连通性测试路由；无连接服务的 profile 下不注册，届时按钮报失败原因。 */
export function installProbeRoute(ctx: Context): void {
    ctx.inject(['connection'], (child) => {
        const connection = child.get('connection') as {
            fetch: { register: (route: unknown) => () => Promise<void> }
        }
        child.effect(function* () {
            const dispose = connection.fetch.register({
                path: TEST_ROUTE,
                methods: ['POST'],
                requestBody: 'buffered',
                fetch: async (request: Request) => {
                    let payload: unknown
                    try {
                        payload = await request.json()
                    } catch {
                        return new Response('invalid json body', { status: 400 })
                    }
                    const result = await probe(ctx, payload, request.signal)
                    return Response.json(result)
                },
            })
            yield dispose
        }, 'auto-review: probe route')
    })
}
