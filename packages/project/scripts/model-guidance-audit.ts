import '../../agent/src/index'

import { createHash } from 'node:crypto'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { DefaultToolContractExampleRegistry } from '@velaros-ai/agent/tool-contract'

import { configureAppRuntimeFacts, readAppRuntimeFacts } from '../../agent/src/agent/AppRuntimeFacts'
import { projectFileContext } from '../../agent/src/agent/context/resources/FileContextProjection'
import { createBuiltInPromptSegments } from '../../agent/src/prompts/catalog'
import { PromptRegistry } from '../../agent/src/prompts/registry'
import { createRuntimePromptSegments } from '../../agent/src/prompts/segments/runtime'
import type { RuntimePromptSnapshot } from '../../agent/src/prompts/segments/shared'
import { DefaultToolContractExampleRegistry as SourceToolExamples } from '../../agent/src/tool-contract/examples'
import { schemaToInputSchema } from '../../agent/src/tool-contract/schema-bundle'
import { categoriesTools } from '../../agent/src/tool-library/builtin/Categories.tool'
import { contextRetrievalTools } from '../../agent/src/tool-library/builtin/ContextRetrieval.tool'
import { plansTools } from '../../agent/src/tool-library/builtin/Plans.tool'
import { ToolArgsSchemaValidator } from '../../agent/src/tools/ToolArgsSchemaValidator'
import { projectTools } from '../src/agent/Project.tool'

const root = resolve(import.meta.dir, '../../..')
export const ProjectGuidanceReviewPath = resolve(root, 'docs/engineering/project-model-guidance-review.json')

export interface GuidanceTool {
  name: string
  description: string
  schema: Parameters<typeof schemaToInputSchema>[0]
  examples?: ReadonlyArray<Record<string, unknown>>
}

export function registeredGuidanceTools(tools: ReadonlyArray<Omit<GuidanceTool, 'examples'>>): GuidanceTool[] {
  return tools.map((tool) => ({ ...tool, examples: [DefaultToolContractExampleRegistry, SourceToolExamples]
    .map((registry) => registry.get(tool.name)).find((examples) => examples?.every((example) => tool.description.includes(JSON.stringify(example)))) }))
}

export const GuidanceSources = [
  { entry: 'Project 工具注册与 schema', sources: ['packages/project/src/agent/Project.tool.ts', 'packages/project/src/agent/tools', 'packages/project/src/agent/contracts', 'packages/project/src/project-code-contracts.ts'] },
  { entry: 'RunContext → PromptState → 内置段组装', sources: ['packages/agent/src/agent/run-context/RunContext.ts', 'packages/agent/src/agent/PromptState.ts', 'packages/agent/src/prompts/catalog.ts', 'packages/agent/src/prompts/segments/runtime.ts', 'packages/agent/src/prompts/segments/task.ts'] },
  { entry: '能力发现、换入、计划与主动召回', sources: ['packages/agent/src/tool-library/builtin/Categories.tool.ts', 'packages/agent/src/tool-library/builtin/ContextRetrieval.ts', 'packages/agent/src/tool-library/builtin/ContextRetrieval.tool.ts', 'packages/agent/src/tool-library/builtin/Plans.tool.ts'] },
  { entry: '参数失败恢复与当前源码指导', sources: ['packages/agent/src/tools/ToolArgsSchemaValidator.ts', 'packages/agent/src/tools/recovery/ToolInputReuse.ts', 'packages/agent/src/tools/recovery/TransientRecoveryProjection.ts', 'packages/agent/src/agent/context/resources/FileContextProjection.ts', 'packages/project/src/transactions/transaction-errors.ts'] },
  { entry: '模型回执与最终读取引用', sources: ['packages/agent/src/tools/Executor.ts', 'packages/agent/src/tools/toolInputHistoryProjection.ts', 'packages/project/src/agent/presentation/source-window.ts', 'packages/project/src/agent/ProjectKernelPort.ts'] },
  { entry: '用户可读示例与实现说明', sources: ['packages/project/README.md', 'docs/engineering/project-tool-surface-redesign-proposal.md', 'docs/engineering/project-tool-surface-implementation.md', 'docs/engineering/project-text-protocol.md'] },
]

export function validateGuidanceExamples(tools: readonly GuidanceTool[]): void {
  for (const tool of tools) {
    // 控制工具依角色决定是否注入；静态 Project 描述把发现路由交给当前运行时指导。
    if (tool.name.startsWith('project:') && /tooling:(?:map|replace)/u.test(tool.description))
      throw new Error(`${tool.name}: static guidance names role-dependent discovery tools; use current capability guidance`)
    if (!tool.examples?.length) throw new Error(`${tool.name}: missing reviewed examples`)
    for (const example of tool.examples) {
      const wire = JSON.stringify(example)
      const parsed = tool.schema.safeParse(JSON.parse(wire))
      if (!parsed.success) throw new Error(`${tool.name}: example rejected by current schema: ${parsed.error.message}`)
      if (!tool.description.includes(wire)) throw new Error(`${tool.name}: visible example differs from registered input`)
      if (/<(?:fileRef|changeRef)>/u.test(wire) && !tool.description.includes('必须替换')) throw new Error(`${tool.name}: reference placeholder has no substitution instruction`)
    }
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]))
  return value
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex') }

function toolArtifacts(tools: readonly GuidanceTool[]) {
  validateGuidanceExamples(tools)
  return tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: schemaToInputSchema(tool.schema), examples: tool.examples }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function promptMatrix() {
  const priorFacts = readAppRuntimeFacts()
  const outputs: unknown[] = []
  const registered = new Set<string>()
  const rendered = new Set<string>()
  try {
    for (const platform of ['darwin', 'win32', 'linux']) {
      configureAppRuntimeFacts({ appVersion: 'audit', platform, arch: 'audit', osRelease: 'audit', shell: platform === 'win32' ? 'pwsh' : '/bin/sh', homeDir: '/audit', userDataRoot: '/audit/data' })
      for (const locale of ['zh-CN', 'en-US'] as const) for (const contextPhase of ['bootstrap', 'operational'] as const) for (const plan of [false, true]) for (const goal of [false, true]) for (const visual of [false, true]) for (const skillsReadable of [false, true]) {
        const snapshot: RuntimePromptSnapshot = {
          locale, roleId: 'primary-agent', roleLabel: 'Agent', workflowType: 'general', thinkingDepth: 'balanced', developerContext: null,
          agentSurfaceId: 'chat', contextPhase, activeCapabilityScope: 'system', toolCategories: ['project-files'], toolSurfaceProfile: 'default', runProfile: 'balanced',
          toolCapabilityCategories: [{ id: 'project-files', label: 'Project', description: 'Current tools', enabled: true, toolOsDefaultState: 'resident', tools: [...Object.values(projectTools), ...Object.values(categoriesTools), ...Object.values(contextRetrievalTools), { name: 'agent:dispatch', description: 'Delegate a bounded task' }, { name: 'context:handoff', description: 'Transfer context' }].map(({ name, description }) => ({ name, description })), hiddenToolCount: 0 }],
          requestableToolCapabilityCategories: [], canUpdatePlan: true, userRequestedPlan: plan, goalMode: goal,
          selectedPromptFeatureLabels: visual ? ['Widget', 'HTML'] : [], enabledPromptFeatures: visual ? ['widget', 'html-artifact'] : [], autoPromptFeatureLabels: [], availableSkills: [], customSubAgents: [{ id: 'audit-agent', description: 'Independent review', base: 'primary-agent' }],
          executionPlanPreview: plan ? '当前任务进度' : null, currentExecutionAdvice: null, recentToolFailures: [], hasCompactedContext: false,
        }
        const definitions = [...createBuiltInPromptSegments(), ...createRuntimePromptSegments(snapshot)]
        const result = new PromptRegistry(definitions).compose({ chatConfig: { systemPromptAppend: '<user appendix>' }, facts: { shouldInjectVisualWidgetPrompt: visual, shouldInjectHtmlArtifactPrompt: visual, readableSkillIds: skillsReadable ? ['widget-visual-output', 'html-artifact-output'] : [] } })
        definitions.forEach(({ id }) => registered.add(id))
        ;[...result.stableParts, ...result.dynamicParts].forEach(({ id }) => rendered.add(id))
        outputs.push({ platform, locale, contextPhase, plan, goal, visual, skillsReadable, registered: definitions.map(({ id }) => id),
          // 仅时间值可变；段身份、所有静态指导与环境格式均参与指纹。
          composition: JSON.parse(JSON.stringify(result).replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/gu, '<current-time>')),
        })
      }
    }
  } finally { configureAppRuntimeFacts(priorFacts) }
  const unrendered = [...registered].filter((id) => !rendered.has(id))
  if (unrendered.length) throw new Error(`Prompt matrix never rendered: ${unrendered.join(', ')}`)
  return outputs
}

async function sourceArtifacts() {
  const paths = new Set<string>()
  const visit = async (path: string): Promise<void> => {
    const info = await stat(resolve(root, path))
    if (info.isDirectory()) {
      for (const entry of (await readdir(resolve(root, path))).sort()) await visit(`${path}/${entry}`)
    } else paths.add(path)
  }
  for (const source of GuidanceSources.flatMap(({ sources }) => sources)) await visit(source)
  return Promise.all([...paths].sort().map(async (path) => ({ path, fingerprint: digest(await readFile(resolve(root, path), 'utf8')) })))
}

export async function collectGuidanceReview(reviewTools = registeredGuidanceTools(Object.values(projectTools))) {
  const project = toolArtifacts(reviewTools)
  const builtin = toolArtifacts(registeredGuidanceTools([...Object.values(categoriesTools), ...Object.values(contextRetrievalTools), ...Object.values(plansTools)]))
  const matrix = promptMatrix()
  const currentView = projectFileContext([], [{
    workspaceId: '/audit', path: 'source.ts', status: 'fresh', refs: [], sequence: 1, priority: 1, ranges: [{ startLine: 1, endLine: 1 }], snapshots: [{ workspaceId: '/audit', path: 'source.ts', revision: 'audit', content: 'source', exists: true, complete: true, range: { startLine: 1, endLine: 1 }, totalLines: 1 }],
  }], 8000).tail[0]?.content
  const guidance = { builtin, matrix, currentView, validationActions: new ToolArgsSchemaValidator().buildValidationNextActions('tool:example') }
  const documents = await Promise.all(['packages/project/README.md', 'docs/engineering/project-tool-surface-redesign-proposal.md'].map(async (path) => {
    const text = await readFile(resolve(root, path), 'utf8')
    return { path, text, examples: [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/gu)].map((match) => JSON.parse(match[1]!)) }
  }))
  return { version: 1, toolNames: project.map(({ name }) => name), matrixCases: matrix.length, sources: GuidanceSources,
    fingerprints: { project: digest(project), agent: digest(guidance), documents: digest(documents) }, sourceArtifacts: await sourceArtifacts() }
}

export function assertGuidanceReviewed(actual: Awaited<ReturnType<typeof collectGuidanceReview>>, reviewed: unknown): void {
  if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(reviewed)))
    throw new Error('Project model guidance changed. Review tool schemas, examples, prompt composition and host guides, then explicitly update project-model-guidance-review.json.')
}

if (import.meta.main) {
  const actual = await collectGuidanceReview()
  if (process.argv.includes('--write-reviewed')) {
    await writeFile(ProjectGuidanceReviewPath, `${JSON.stringify(actual, null, 2)}\n`)
    process.stdout.write('Saved the explicitly reviewed Project model guidance fingerprint.\n')
  } else {
    assertGuidanceReviewed(actual, JSON.parse(await readFile(ProjectGuidanceReviewPath, 'utf8')))
    process.stdout.write(`Project model guidance matches its review (${actual.toolNames.length} tools, ${actual.matrixCases} prompt cases).\n`)
  }
}
