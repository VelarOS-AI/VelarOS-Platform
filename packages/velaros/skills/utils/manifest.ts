import { isBuiltin } from 'node:module'
import { isAbsolute } from 'node:path'

import { valid, validRange } from 'semver'
import { parse } from 'yaml'
import { z } from 'zod'

import { isEmpty, isObject } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { SkillLimits } from '../contract/constants.js'
import type { SkillIndex, SkillManifest, SkillReceipt } from '../types/skills.js'

/** 与 npm 裸包名一致，保留 Node 和宿主使用的命名空间。 */
export function isSkillPackageName(name: string): boolean {
  return (
    /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(name) &&
    !isBuiltin(name) &&
    name !== 'velaros' &&
    name.length <= 214
  )
}

/** 包内资源必须是确定的相对文件路径。 */
export function isSkillRelativePath(path: string): boolean {
  return (
    !isEmpty(path) &&
    !isAbsolute(path) &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !path.split('/').some((part) => part === '..' || isEmpty(part) || part === '.') &&
    !path.includes(':')
  )
}

const Name = z.string().refine(isSkillPackageName)
const Path = z.string().refine(isSkillRelativePath)
const Contribution = z
  .object({
    instructions: Path.optional(),
    packages: z.array(Name).max(SkillLimits.packages).default([]),
    capabilities: z
      .array(
        z
          .object({
            module: z.string().regex(/^skill:[a-z][a-z0-9-]*$/u),
            entry: Path,
            contract: Path,
          })
          .strict()
      )
      .max(SkillLimits.capabilities)
      .default([]),
  })
  .strict()
const Manifest = z
  .object({
    name: Name,
    version: z.string().refine((value) => Boolean(valid(value))),
    description: z.string().default(''),
    dependencies: z.record(Name, z.string().min(1)).default({}),
    engines: z
      .object({
        node: z
          .string()
          .refine((value) => Boolean(validRange(value)))
          .optional(),
      })
      .passthrough()
      .optional(),
    agentSkill: Contribution,
  })
  .passthrough()

const InstalledManifest = z
  .object({
    name: Name,
    version: z.string().refine((value) => Boolean(valid(value))),
    description: z.string(),
    dependencies: z.record(Name, z.string()),
    node: z.string().optional(),
    contribution: Contribution,
  })
  .strict()

const Index = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    skills: z.array(
      z
        .object({
          manifest: InstalledManifest,
          generation: z.string().uuid(),
          directory: z.string(),
          enabled: z.boolean(),
          grants: z.array(z.string()),
          installedAt: z.string().datetime(),
        })
        .strict()
    ),
  })
  .strict()

/** 纯说明目录适配为普通 Skill 清单；正文始终保留在 SKILL.md。 */
export function skillInstructionsManifest(source: string): unknown {
  const header = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1]
  if (!header)
    throw new AppError('VALIDATION', 'SKILL.md 需要 name 和 description 的 YAML frontmatter')
  const parsed = z
    .object({ name: Name, description: z.string().min(1) })
    .passthrough()
    .safeParse(parse(header))
  if (!parsed.success)
    throw new AppError('VALIDATION', `SKILL.md 元数据无效：${parsed.error.message}`)
  return {
    name: parsed.data.name,
    version: '0.0.0',
    description: parsed.data.description,
    agentSkill: { instructions: 'SKILL.md' },
  }
}

/** 索引格式在磁盘边界核验，不接受额外行为或未声明字段。 */
export function parseSkillIndex(value: unknown): SkillIndex {
  const parsed = Index.safeParse(value)
  if (!parsed.success)
    throw new AppError('VALIDATION', `Skill 安装索引无效：${parsed.error.message}`)
  if (
    new Set(parsed.data.skills.map((skill) => skill.manifest.name)).size !==
    parsed.data.skills.length
  )
    throw new AppError('CONFLICT', 'Skill 安装索引存在重复身份')
  for (const skill of parsed.data.skills) checkSkillGrants(skill.manifest, skill.grants)
  return parsed.data
}

/** 收据只接受有界相对路径及内容散列。 */
export function parseSkillReceipt(value: unknown): SkillReceipt {
  const parsed = z
    .object({
      manifest: InstalledManifest,
      files: z.record(Path, z.string().regex(/^(?:[a-f0-9]{64}|link:.+)$/u)),
    })
    .strict()
    .safeParse(value)
  if (!parsed.success)
    throw new AppError('VALIDATION', `Skill 安装收据无效：${parsed.error.message}`)
  return parsed.data
}

/** 一次解析 npm 清单的 Skill 贡献，版本和依赖字段保持 npm 原义。 */
export function parseSkillManifest(value: unknown): SkillManifest {
  const parsed = Manifest.safeParse(value)
  if (!parsed.success)
    throw new AppError('VALIDATION', `Skill package.json 无效：${parsed.error.message}`)
  const item = parsed.data
  const contribution = item.agentSkill
  if (
    !contribution.instructions &&
    isEmpty(contribution.packages) &&
    isEmpty(contribution.capabilities)
  )
    throw new AppError('VALIDATION', 'Skill 需要提供说明、标准依赖或宿主能力')
  if (
    new Set(contribution.packages).size !== contribution.packages.length ||
    new Set(contribution.capabilities.map((capability) => capability.module)).size !==
      contribution.capabilities.length
  )
    throw new AppError('CONFLICT', 'Skill 贡献包含重复的包名或能力名')
  for (const name of contribution.packages)
    if (name !== item.name && !Object.hasOwn(item.dependencies, name))
      throw new AppError('VALIDATION', `公开包 ${name} 必须在 dependencies 声明`)
  return {
    name: item.name,
    version: item.version,
    description: item.description,
    dependencies: item.dependencies,
    node: item.engines?.node,
    contribution,
  }
}

/** 能力授权只能引用该 Skill 实际声明的能力。 */
export function checkSkillGrants(manifest: SkillManifest, grants: readonly string[]): void {
  if (
    new Set(grants).size !== grants.length ||
    grants.some(
      (module) =>
        !manifest.contribution.capabilities.some((capability) => capability.module === module)
    )
  )
    throw new AppError('VALIDATION', 'Skill 授权包含未知或重复的能力')
}

/** 租约来自磁盘，只接受单个正进程号和本环境产生的身份。 */
export function parseSkillLease(value: unknown): {
  pid: number
  environment: string
  generations: string[]
} {
  const parsed = z
    .object({
      pid: z.number().int().positive(),
      environment: z.string().regex(/^[a-f0-9]{64}$/u),
      generations: z.array(z.string().uuid()),
    })
    .strict()
    .safeParse(value)
  if (!parsed.success)
    throw new AppError('VALIDATION', `Skill 环境租约无效：${parsed.error.message}`)
  return parsed.data
}

/** 环境描述只有 JSON 数据，递归冻结保证持有者不能改写另一个会话的装配事实。 */
export function freezeSkillData<T>(value: T): T {
  if (isObject(value)) {
    for (const item of Object.values(value)) freezeSkillData(item)
    Object.freeze(value)
  }
  return value
}
