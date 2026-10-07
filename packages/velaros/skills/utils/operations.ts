import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

import { z } from 'zod'

import { AppError } from '@velaros-ai/core/error'

import type { SkillActivation, SkillRecord, SkillSummary } from '../types/skills.js'

import { isSkillPackageName } from './manifest.js'
import { containedSkillPath } from './package-io.js'

/** 管理操作的来源目录遵循调用会话的实际沙箱范围，符号链接不能扩大读取权限。 */
export async function resolveSkillSource(
  directory: string,
  cwd: string,
  scope: 'workspace' | 'unrestricted'
): Promise<string> {
  const path = resolve(cwd, directory)
  return scope === 'workspace' ? containedSkillPath(cwd, path) : realpath(path)
}

/** 模型传入的管理请求在操作边界严格核对，数量上限与公开合同共用常量。 */
export const SkillOperationInputs = {
  guide: z.object({ topic: z.enum(['authoring', 'management', 'example']).optional() }).strict(),
  name: z.object({ name: z.string().refine(isSkillPackageName) }).strict(),
  directory: z.object({ directory: z.string().min(1) }).strict(),
  install: z
    .object({
      directory: z.string().min(1),
      allowDependencyScripts: z.boolean().optional(),
    })
    .strict(),
}

/** 解析失败给出稳定错误码，不把校验器内部异常当成宿主故障。 */
export function parseSkillInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new AppError('VALIDATION', `Skill 请求无效：${parsed.error.message}`)
  return parsed.data
}

/** 持久安装状态与本轮固定版本一起决定可加载性，正文不进入发现清单。 */
export function skillSummary(
  record: SkillRecord,
  selected: readonly SkillActivation[]
): SkillSummary {
  const summary: SkillSummary = {
    name: record.manifest.name,
    version: record.manifest.version,
    description: record.manifest.description,
    available: selected.some((item) => item.generation === record.generation),
    packages: record.manifest.contribution.packages,
    capabilities: [
      ...record.manifest.contribution.capabilities.map((item) => item.module),
      ...(record.manifest.contribution.hostCapabilities ?? []),
    ],
    grants: selected.find((item) => item.generation === record.generation)?.grants ?? [],
  }
  return record.builtin ? { ...summary, builtin: true } : summary
}
