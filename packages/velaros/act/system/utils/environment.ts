import { isBuiltin } from 'node:module'

import { z } from 'zod'

import { isArray, isEmpty, isPlainObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { EnvironmentLimits } from '../contract/constants.js'
import type {
  EnvironmentApply,
  EnvironmentIndex,
  EnvironmentPackageDescription,
  EnvironmentSearch,
  EnvironmentState,
} from '../types/environment.js'

/** registry 包名与 npm alias 的导入名共用相同边界。 */
export function environmentPackageName(name: string): string {
  if (
    !isString(name) ||
    name.length > EnvironmentLimits.nameChars ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(name) ||
    isBuiltin(name) ||
    ['velaros', 'node_modules', 'package.json'].includes(name)
  )
    throw new AppError(
      'VALIDATION',
      `无效或保留的 npm 包名：${String(name).slice(0, EnvironmentLimits.nameChars)}`
    )
  return name
}

/** 只接纳 registry 包规格；路径、URL 与 git 来源不进入受管环境。 */
export function environmentPackageSpec(spec: string): string {
  if (!isString(spec) || spec.length > EnvironmentLimits.specChars)
    throw new AppError('VALIDATION', 'npm 包规格过长')
  const split = spec.indexOf('@', 1)
  const name = environmentPackageName(split < 0 ? spec : spec.slice(0, split))
  if (split < 0) return name
  const version = spec.slice(split + 1)
  if (version.startsWith('npm:')) {
    const target = version.slice(4)
    if (target.includes('npm:')) throw new AppError('VALIDATION', 'npm alias 不能嵌套')
    environmentPackageSpec(target)
  } else if (!version || !/^[a-zA-Z0-9._*+^~<>=| -]+$/u.test(version))
    throw new AppError('VALIDATION', 'npm 版本需要标签、版本号或 semver 范围')
  return name
}

/** 校验并固定一次环境变更的输入，限制值与模型合同共用。 */
export function validateEnvironmentApply(input: EnvironmentApply): EnvironmentApply {
  environmentRevision(input.baseRevision)
  const install = [...(input.install ?? [])]
  const remove = [...(input.remove ?? [])]
  if (
    (isEmpty(install) && isEmpty(remove)) ||
    install.length > EnvironmentLimits.changes ||
    remove.length > EnvironmentLimits.changes
  )
    throw new AppError(
      'VALIDATION',
      `安装和删除各最多 ${EnvironmentLimits.changes} 项，至少提供一项变更`
    )
  const names = install.map(environmentPackageSpec)
  remove.forEach(environmentPackageName)
  if (
    new Set(names).size !== names.length ||
    new Set(remove).size !== remove.length ||
    names.some((name) => remove.includes(name))
  )
    throw new AppError('CONFLICT', '一次变更中的包名不能重复或同时安装和删除')
  return {
    baseRevision: input.baseRevision,
    install,
    remove,
    allowScripts: Boolean(input.allowScripts),
  }
}

/** 版本号由宿主发布，模型只能携带非负安全整数。 */
export function environmentRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new AppError('VALIDATION', '环境版本需要非负安全整数')
}

/** 搜索查询有界，避免将 npm 的额外选项混入请求。 */
export function validateEnvironmentSearch(input: EnvironmentSearch): Required<EnvironmentSearch> {
  const limit = input.limit ?? EnvironmentLimits.searchDefault
  if (
    !isString(input.query) ||
    !input.query.trim() ||
    input.query.length > EnvironmentLimits.specChars ||
    /\p{Cc}/u.test(input.query) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > EnvironmentLimits.searchResults
  )
    throw new AppError(
      'VALIDATION',
      `搜索关键词最多 ${EnvironmentLimits.specChars} 字符，结果最多 ${EnvironmentLimits.searchResults} 项`
    )
  return { query: input.query, limit }
}

/** 将 npm 第三方资料投影为有界、可移植的说明。 */
export function environmentDescriptions(raw: unknown): EnvironmentPackageDescription[] {
  const items = isArray(raw) ? raw : [raw]
  if (items.length > EnvironmentLimits.searchResults)
    throw new AppError('LIMIT', '匹配版本过多，请指定更精确的版本')
  return items.map((item) => {
    if (!isPlainObject(item) || !isString(item.name) || !isString(item.version))
      throw new AppError('PROTOCOL', 'npm 返回了无效的包说明')
    const strings = (value: unknown): Readonly<Record<string, string>> | undefined => {
      if (!isPlainObject(value)) return undefined
      return Object.fromEntries(
        Object.entries(value)
          .filter((entry): entry is [string, string] => isString(entry[1]))
          .slice(0, EnvironmentLimits.packages)
          .map(([key, value]) => [key, value.slice(0, EnvironmentLimits.specChars)])
      )
    }
    return {
      name: item.name.slice(0, EnvironmentLimits.nameChars),
      version: item.version.slice(0, EnvironmentLimits.specChars),
      description: isString(item.description)
        ? item.description.slice(0, EnvironmentLimits.descriptionChars)
        : undefined,
      homepage: isString(item.homepage)
        ? item.homepage.slice(0, EnvironmentLimits.descriptionChars)
        : undefined,
      engines: strings(item.engines),
      dependencies: strings(item.dependencies),
      peerDependencies: strings(item.peerDependencies),
    }
  })
}

/** 持久索引只接受版本化数据，路径另由磁盘服务核对。 */
export function parseEnvironmentIndex(value: unknown): EnvironmentIndex {
  const parsed = z
    .object({
      format: z.literal(1),
      revision: z.number().int().nonnegative().safe(),
      entries: z
        .array(
          z.object({
            revision: z.number().int().positive().safe(),
            createdAt: z.string(),
            generation: z.object({
              id: z.string().uuid(),
              digest: z.string().regex(/^[a-f0-9]{64}$/u),
              packages: z
                .array(
                  z.object({
                    name: z.string(),
                    package: z.string(),
                    version: z.string(),
                    directory: z.string(),
                    packageJson: z.string(),
                    readme: z.string().optional(),
                    commands: z.array(z.string()),
                  })
                )
                .max(EnvironmentLimits.packages),
            }),
          })
        )
        .max(EnvironmentLimits.history),
    })
    .safeParse(value)
  if (!parsed.success) throw new AppError('VALIDATION', '环境索引已损坏')
  const index = parsed.data
  if (
    (index.entries.at(-1)?.revision ?? 0) !== index.revision ||
    index.entries.some((entry, i) => i > 0 && entry.revision <= index.entries[i - 1]!.revision)
  )
    throw new AppError('VALIDATION', '环境索引版本顺序无效')
  return index
}

/** 当前指针与历史只投影模型需要的安装事实。 */
export function environmentState(index: EnvironmentIndex): EnvironmentState {
  return {
    revision: index.revision,
    packages: index.entries.at(-1)?.generation.packages ?? [],
    history: index.entries.slice(0, -1).map((entry) => ({
      revision: entry.revision,
      createdAt: entry.createdAt,
      packages: entry.generation.packages.map((pkg) => `${pkg.name}@${pkg.version}`),
    })),
  }
}

/** 发布时检测并发版本，避免覆盖另一安装。 */
export function assertEnvironmentRevision(index: EnvironmentIndex, expected: number): void {
  if (index.revision !== expected)
    throw new AppError('CONFLICT', `环境已变化，当前版本为 ${index.revision}；请重新 list 后提交`)
}

/** 环境只保留有界的直接 registry 依赖。 */
export function environmentDependencies(manifest: Record<string, unknown>): Record<string, string> {
  const value = manifest.dependencies ?? {}
  if (
    !isPlainObject(value) ||
    Object.keys(value).length > EnvironmentLimits.packages ||
    Object.values(value).some((spec) => !isString(spec))
  )
    throw new AppError('LIMIT', `环境最多直接安装 ${EnvironmentLimits.packages} 个包`)
  return Object.fromEntries(
    Object.entries(value).map(([name, spec]) => [environmentPackageName(name), String(spec)])
  )
}
