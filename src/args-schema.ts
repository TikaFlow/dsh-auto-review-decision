/**
 * JSON Schema 常用子集的轻量校验：拦截缺失与类型不符的调用参数。
 *
 * 只覆盖宿主工具声明中实际出现的约束（type/required/properties/enum/items/
 * 任意组合），完整 JSON Schema 语义交由模型侧的 contract 问题兜底。
 *
 * @module dsh-auto-review-systemOne/args-schema
 */

import { isRecord } from './shared/tools.ts'

/** 一条参数问题。 */
export interface SchemaIssue {
    /** 问题所在的参数路径，如 `command` 或 `items[2].path`。 */
    readonly path: string
    /** 问题的平实描述。 */
    readonly message: string
}

/** JSON Schema 的类型名单。 */
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'])

/** 判断一个值是否符合单个类型名。 */
function matchesType(value: unknown, type: string): boolean {
    switch (type) {
        case 'string': return typeof value === 'string'
        case 'number': return typeof value === 'number' && Number.isFinite(value)
        case 'integer': return typeof value === 'number' && Number.isInteger(value)
        case 'boolean': return typeof value === 'boolean'
        case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value)
        case 'array': return Array.isArray(value)
        case 'null': return value === null
        default: return true
    }
}

/** 生成人类可读的类型名列表。 */
function typeNames(types: readonly string[]): string {
    return types.join(' 或 ')
}

/** 递归校验一个值与一份 schema。 */
function check(value: unknown, schema: Record<string, unknown>, path: string, issues: SchemaIssue[]): void {
    const declared = schema.type
    if (typeof declared === 'string') {
        if (TYPES.has(declared) && !matchesType(value, declared)) {
            issues.push({ path, message: `${path} 应为 ${declared}，实为 ${describe(value)}` })
            return
        }
    } else if (Array.isArray(declared)) {
        const names = declared.filter((entry): entry is string => typeof entry === 'string')
        if (names.length > 0 && !names.some(type => matchesType(value, type))) {
            issues.push({ path, message: `${path} 应为 ${typeNames(names)}，实为 ${describe(value)}` })
            return
        }
    }
    if (Array.isArray(schema.enum) && schema.enum.length > 0 && !schema.enum.some(entry => entry === value)) {
        issues.push({ path, message: `${path} 不在允许的取值内` })
        return
    }
    if (Array.isArray(value) && isRecord(schema.items)) {
        value.forEach((entry, index) => { check(entry, schema.items as Record<string, unknown>, `${path}[${String(index)}]`, issues) })
        return
    }
    if (isRecord(value) && isRecord(schema.properties)) {
        const properties = schema.properties as Record<string, Record<string, unknown>>
        const required = Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === 'string') : []
        for (const key of required) {
            if (!(key in value)) issues.push({ path, message: `${path} 缺少必填参数 ${key}` })
        }
        for (const [key, child] of Object.entries(properties)) {
            if (key in value) check(value[key], child, path === '' ? key : `${path}.${key}`, issues)
        }
    }
}

/** 把一个未知值描述成简短类型名。 */
function describe(value: unknown): string {
    if (value === null) return 'null'
    if (Array.isArray(value)) return 'array'
    return typeof value
}

/**
 * 校验调用参数是否符合工具的参数定义。
 * @param args - 已解析的调用参数。
 * @param schema - 工具的 JSON Schema `parameters`。
 * @returns 全部问题；空数组表示通过。
 */
export function validateArgs(args: unknown, schema: unknown): readonly SchemaIssue[] {
    const issues: SchemaIssue[] = []
    if (!isRecord(schema)) return issues
    check(args, schema, '', issues)
    return issues
}
