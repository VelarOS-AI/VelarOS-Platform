import { posix } from 'node:path'

import { isArray, isEmpty, isPlainObject, trimmedStringOrEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { VelarModArchiveInstallFailureReason } from '../../types/mods.js'

export const MaxPathLength = 240

export const MaxPathDepth = 8

/**
 * 判串里是否含控制字符（码点 ≤ 0x1F 或等于 0x7F）。
 * mod 包里的路径带控制字符不是笔误就是攻击：换行能伪造日志、`\r` 能把终端上显示的路径改成另一条，
 * 所以一旦命中整个包直接判不安全，不做清洗后放行。
 */
export function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x1f || codePoint === 0x7f) return true
  }
  return false
}

/**
 * 校验 mod 包里一条条目路径的安全性，通过则返回归一（posix normalize + NFC）后的相对路径，否则抛 `SECURITY` 的 `AppError`。
 *
 * 两类拒绝各带各的 reason 码：绝对路径、Windows 盘符、反斜杠、超过 `MaxPathLength`、含控制字符 → `archive.path-unsafe`；
 * 归一后仍逃出根目录（`.`、`../` 开头、任一段是 `..`）或层级超过 `MaxPathDepth` → `archive.path-escapes-root`。
 * 这是解包前的唯一一道门：路径逃逸意味着 mod 能往安装目录之外写文件，所以**一律拒绝、不做修正后放行**——
 * "帮它改成安全路径"等于替一个可疑包决定它想写哪里。
 * 末尾统一 NFC 归一：macOS 会把文件名拆成分解形，不归一的话同一条路径在比对与落盘两处会对不上。
 */
export function assertArchiveEntryPath(rawPath: string): string {
  if (
    rawPath.startsWith('/')
    || /^[a-z]:\//iu.test(rawPath)
    || rawPath.includes('\\')
    || rawPath.length > MaxPathLength
    || hasControlCharacter(rawPath)
  ) throw new AppError(
    'SECURITY',
    `Mod 包里有不安全的条目路径：${JSON.stringify(rawPath)}。绝对路径、Windows 盘符、反斜杠、控制字符与超长路径一律拒绝解包，不会替它改成安全路径。`,
    undefined,
    { reason: 'archive.path-unsafe' satisfies VelarModArchiveInstallFailureReason },
  )

  const normalized = posix.normalize(rawPath)
  const segments = normalized.split('/')
  if (
    normalized === '.'
    || normalized.startsWith('../')
    || segments.includes('..')
    || segments.length > MaxPathDepth
  ) throw new AppError(
    'SECURITY',
    `Mod 包的条目路径逃出了安装根目录或层级过深：${JSON.stringify(rawPath)}。路径归一后不得以 ../ 开头、不得含 .. 段，层级也不能超过上限，否则 mod 就能往安装目录之外写文件。`,
    undefined,
    { reason: 'archive.path-escapes-root' satisfies VelarModArchiveInstallFailureReason },
  )
  return normalized.normalize('NFC')
}

/**
 * 从 mod 清单这类不可信 JSON 里读一个文本字段：是字符串就去首尾空白返回，其余一切形态（数字、对象、缺席）一律返回空串。
 * 清单是第三方写的，任何字段都可能是任何类型；这里选择"读不出来就当没写"而不是抛错，好让一个字段写错不至于让整个包装不上。
 */
export function readText(value: unknown): string {
  return trimmedStringOrEmpty(value)
}

/**
 * 从 mod 清单的 agent 段读出四项展示元数据（显示名 / 说明 / 发布者 / 自称信任级）。
 * 整段不是对象时返回一份只填了 `fallbackId` 作显示名、其余全空的兜底——清单残缺不该让安装流程崩，界面上至少还有个名字。
 * `claimedTrust` 的命名是有意的：那是**包自己声称**的信任级别，只作展示，绝不能当作授权依据。
 */
export function readAgentMetadata(agent: unknown, fallbackId: string) {
  if (!isPlainObject(agent)) return { displayName: fallbackId, description: '', publisher: '', claimedTrust: '' }
  return {
    displayName: readText(agent.displayName) || fallbackId,
    description: readText(agent.description),
    publisher: readText(agent.publisher),
    claimedTrust: readText(agent.trust),
  }
}

/**
 * 数这个 mod 在各贡献轴上分别声明了几条，产出「轴名 → 条数」的表，供安装预览告诉用户"这个包会往哪几处加东西"。
 * 只统计值为**非空数组**的轴：空数组与非数组的轴整条不出现在结果里（不记 0），免得预览列一堆"该轴 0 项"的噪声。
 * 清单不是对象、或没有 `contributes` 段时返回空表。轴名原样透传，本函数不认识也不校验任何具体轴。
 */
export function countContributions(agent: unknown): Readonly<Record<string, number>> {
  if (!isPlainObject(agent) || !isPlainObject(agent.contributes)) return {}
  return Object.fromEntries(
    Object.entries(agent.contributes)
      .filter(([, entries]) => isArray(entries) && !isEmpty(entries))
      .map(([axis, entries]) => [axis, (entries as readonly unknown[]).length]),
  )
}
