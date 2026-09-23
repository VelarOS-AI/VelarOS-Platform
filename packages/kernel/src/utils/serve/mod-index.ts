import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  isArray,
  isFalse,
  isFunction,
  isNull,
  isObject,
  isString,
  optionalWhen,
  stringifyPretty,
} from '@velaros-ai/core'

import type { KernelModuleDefinition } from '../../contract/requires.js'
import type {
  KernelModPackRecord,
  KernelModStorePaths,
  KernelSystemModPackInput,
} from '../../types/serve.js'
import type { VelarosModModuleSection } from '../../types/wire.js'
import { parseVelarosModEnvelope, VelarosModManifestFileName } from '../wire/mod-envelope'

/** 按数据根目录折出 ModStore 的落盘路径（不给根就用缺省的 `~/.velaros`）。 */
export function toModStorePaths(root: string = join(homedir(), '.velaros')): KernelModStorePaths {
  return {
    userModsDirectory: join(root, 'mods'),
    indexPath: join(root, 'mod-index.json'),
  }
}

/** 把装载失败的原因折成一句人读得懂的话（带上 cause，别把真正的原因丢在最里层）。 */
export function describeModPackLoadFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause
  const causeText = cause instanceof Error ? ` (cause: ${cause.message})` : ''
  return `${error.name}: ${error.message}${causeText}`
}

/** 把 pack 的 `specifier` 折成可以 import 的 file URL；相对路径按进程工作目录解析。 */
export function toModPackImportUrl(specifier: string): string {
  const resolved = isAbsolute(specifier) ? specifier : resolve(process.cwd(), specifier)
  return pathToFileURL(resolved).href
}

/** 判一个值是不是模块定义：有清单、有 activate 就算；形状不对的 pack 在这里被挡下。 */
export function toKernelModuleDefinition(value: unknown): KernelModuleDefinition | undefined {
  if (!isObject(value) || isNull(value)) return undefined
  const manifest = Reflect.get(value, 'manifest')
  const activate = Reflect.get(value, 'activate')
  return isObject(manifest) && isFunction(activate) ? (value as KernelModuleDefinition) : undefined
}

/** 把持久化索引里的一条记录折成 pack 记录；字段缺斤少两的那条直接跳过（返回 undefined）。 */
export function toModPackRecordFromIndexEntry(entry: unknown): KernelModPackRecord | undefined {
  if (!isObject(entry) || isNull(entry)) return undefined
  const id = Reflect.get(entry, 'id')
  const kind = Reflect.get(entry, 'kind')
  const version = Reflect.get(entry, 'version')
  const specifier = Reflect.get(entry, 'specifier')
  const provides = Reflect.get(entry, 'provides')
  const enabled = Reflect.get(entry, 'enabled')
  const exportName = Reflect.get(entry, 'exportName')
  if (!isString(id) || !isString(version) || !isString(specifier) || !isArray(provides))
    return undefined
  if (kind !== 'system' && kind !== 'user' && kind !== 'contrib') return undefined
  return {
    id,
    kind,
    version,
    specifier,
    enabled: !isFalse(enabled),
    provides: provides.filter((item): item is string => isString(item)),
    exportName: optionalWhen(isString, exportName),
  }
}

/**
 * 折出要落盘的 mod 索引文本（身份加开关位）。
 *
 * bundled pack 的 `module` 是活的对象图、不是数据，这里刻意丢掉：索引持久化的是**决定**
 * （用户关掉了哪些 pack），载荷永远从构建图里再来一次。
 */
export function toModPackIndexFileContent(packs: readonly KernelModPackRecord[]): string {
  const entries = packs.map(({ module: _module, ...record }) => record)
  return `${stringifyPretty({ packs: entries })}\n`
}

/**
 * 读一个 pack 目录的 `velaros.mod.json`，只取 `module` 一节。
 *
 * `agent` / `ui` 归 Agent 主干与产品外壳，这里连看都不看——这条读取权限的切分，是挡住装载器
 * 长回上帝对象的机械防线。清单不是 JSON、或者不合信封 schema 时抛错，原因原样带出去。
 */
export function parseModPackDirectoryManifest(
  raw: string,
  manifestPath: string
): VelarosModModuleSection {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(`${manifestPath} 上的 ${VelarosModManifestFileName} 不是合法 JSON`, {
      cause: error,
    })
  }
  const envelope = parseVelarosModEnvelope(parsed, { origin: manifestPath })
  if (!envelope.ok) {
    throw new Error(
      envelope.diagnostics
        .map((diagnostic) => `${diagnostic.path ?? '<root>'}: ${diagnostic.message}`)
        .join('; ')
    )
  }
  return envelope.envelope.module
}

/** 解析 `VELAROS_KERNEL_SYSTEM_PACKS` 里的 JSON 数组；不是数组就抛错，别让守护进程带着半份清单起来。 */
export function parseKernelSystemModPacks(json: string): readonly KernelSystemModPackInput[] {
  const parsed = JSON.parse(json) as unknown
  if (!isArray(parsed)) {
    throw new Error('VELAROS_KERNEL_SYSTEM_PACKS 必须是一个 JSON 数组')
  }
  return parsed as readonly KernelSystemModPackInput[]
}
