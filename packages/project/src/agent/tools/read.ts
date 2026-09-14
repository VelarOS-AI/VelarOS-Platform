import { isEmpty, isNotUndefined, optionalWhen } from '@velaros-ai/core'

import { resolveProjectReadPage } from '../../context/file-refs.js'
import { ProjectError } from '../../errors.js'
import { ProjectToolNames } from '../../project-tool-names.js'
import { type ProjectReadInput,ProjectReadInputSchema, readLineRange } from '../contracts/read.js'
import { presentProjectRead, ProjectSourceInstructions, type ProjectSourceWindow } from '../presentation/source-window.js'
import { ProjectReadCapability } from '../ProjectCapabilities.js'
import { registerProjectFileContext, snapshotFromRead } from '../ProjectFileContext.js'
import { type AgentProjectReadResult,executeAgentProjectRead, toAgentProjectErrorObject } from '../ProjectKernelPort.js'
import type { ProjectToolContext } from '../Types.js'

import { defineProjectTool } from './shared.js'

export async function executeProjectRead(input: ProjectReadInput, context: ProjectToolContext) {
  context.abortSignal.throwIfAborted()
  const parsed = ProjectReadInputSchema.parse(input)
  const kernel = await context.project.kernel()
  const coordinator = registerProjectFileContext(context)
  const sequence = coordinator?.beginObservation()
  const page = parsed.continuation ? await resolveProjectReadPage(context, parsed.continuation) : undefined
  if (page) {
    const current = await kernel.read({ path: page.path, baseRevision: page.revision, maxChars: Math.max(1, page.content.length + 1) })
    if (current.redacted || current.truncated || current.hasMore || current.content !== page.content)
      throw new ProjectError('BASE_REVISION_MISMATCH', 'Read continuation belongs to a changed file; start a new read.')
  }
  const requests = page ? [{ path: page.path, range: page.range, baseRevision: page.revision }]
    : parsed.files?.map((file) => ({ path: file.path, range: readLineRange(file.range), baseRevision: undefined }))
      ?? [{ path: parsed.path!, range: readLineRange(parsed.range), baseRevision: undefined }]
  let remaining = parsed.maxChars ?? 24_000
  const files: ProjectSourceWindow[] = []
  const issues: unknown[] = []
  const snapshots: AgentProjectReadResult[] = []
  for (const [index, request] of requests.entries()) {
    context.abortSignal.throwIfAborted()
    try {
      const result = await executeAgentProjectRead(kernel, {
        path: request.path, range: request.range,
        baseRevisions: request.baseRevision ? { [request.path]: request.baseRevision } : undefined,
        maxChars: Math.max(1, Math.floor(remaining / (requests.length - index))),
      }, { rootPath: context.project.getRootPath() })
      issues.push(...(result.issues ?? []))
      for (const file of result.files) {
        files.push(await presentProjectRead(context, file, request.range, page?.source))
        snapshots.push(file)
        remaining = Math.max(0, remaining - [...(file.content ?? '')].length)
      }
    } catch (error) {
      if (requests.length === 1) throw error
      issues.push({ path: request.path, reason: 'failed', ...toAgentProjectErrorObject(error) })
    }
  }
  if (coordinator && isNotUndefined(sequence)) await coordinator.observe(snapshots.flatMap((file, index) => {
    const snapshot = snapshotFromRead(context.project.getRootPath(), file)
    const view = files[index]
    return snapshot ? [{ ...snapshot, viewSource: view?.viewSource, presentation: view ? {
      lines: view.lines, fragments: view.fragments,
      continuation: view.continuation, hasMore: file.hasMore,
    } : undefined }] : []
  }), sequence, context.toolCallId)
  return { rootPath: context.project.getRootPath(), count: files.length, files, issues: optionalWhen(!isEmpty(issues), issues) }
}

export const projectRead = defineProjectTool<ProjectReadInput>({
  name: ProjectToolNames.read, category: 'project-files', role: 'inspect',
  summary: 'Read versioned source lines and receive fileRef targets for editing.',
  usage: [ProjectSourceInstructions, 'Use path with range (51 or [42,45]), files with independent ranges, or the returned continuation. maxChars is a shared total character budget.'],
  examples: [{ files: [{ path: 'src/service.ts', range: [42, 60] }, { path: 'src/types.ts', range: 20 }] }],
  schema: ProjectReadInputSchema, permissions: ['fs:read'], capabilities: ProjectReadCapability,
  exposure: { tier: 'common', rank: 10 }, isConcurrencySafe: () => true,
  execute: executeProjectRead,
})
