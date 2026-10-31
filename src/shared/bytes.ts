/**
 * 字节计量：把文本按 UTF-8 折算成字节数。
 *
 * @module dsh-auto-review-systemOne/shared/bytes
 */

const encoder = new TextEncoder()

/**
 * 求一段文本的 UTF-8 字节数。
 * @param text - 待计量的文本。
 * @returns 字节数。
 */
export function byteLength(text: string): number {
    return encoder.encode(text).length
}
