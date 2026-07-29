import { toNullable, toOptional } from '@velaros-ai/core'

import type { ContextWorkingSetBlock } from './ContextLedger'
import type { ContextResourceStateInput } from './ContextWorkingSetOS'

export interface ContextEvidenceGraphNode {
  blockId: string
  filePaths: string[]
  contentHash?: string
  resourceRevision?: string
  stale: boolean
  staleReasons: string[]
}

export interface ContextEvidenceGraph {
  nodesByBlockId: Map<string, ContextEvidenceGraphNode>
  staleBlockIds: Set<string>
}

export interface ContextEvidenceGraphBuilderInput {
  blocks: readonly ContextWorkingSetBlock[]
  resourceState?: LooseOptional<ContextResourceStateInput>
}

const FilePathPattern =
  /(?:^|[\s(["'`])((?:\.{1,2}\/|\/)?[\w@~./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|cpp|cc|cxx|c|h|hpp|cs|rb|php|css|scss|sass|less|html|vue|svelte|json|yaml|yml|toml|mdx?))(?::\d+)?/gmu

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function extractFilePathsFromText(text: string): string[] {
  const paths: string[] = []
  for (const match of text.matchAll(FilePathPattern)) {
    const path = match[1]?.trim()
    if (path) paths.push(path)
  }
  return unique(paths)
}

function resolveBlockFilePaths(block: ContextWorkingSetBlock): string[] {
  return unique([
    block.provenance?.filePath ?? '',
    ...extractFilePathsFromText(block.contentText ?? ''),
  ])
}

function resolveResourceItem(
  resourceState: LooseOptional<ContextResourceStateInput>,
  path: string
): Nullable<NonNullable<ContextResourceStateInput['files']>[number]> {
  return toNullable(resourceState?.files?.find((file) => file.path === path))
}

export class ContextEvidenceGraphBuilder {
  public build(input: ContextEvidenceGraphBuilderInput): ContextEvidenceGraph {
    const nodesByBlockId = new Map<string, ContextEvidenceGraphNode>()
    const staleBlockIds = new Set<string>()

    for (const block of input.blocks) {
      const filePaths = resolveBlockFilePaths(block)
      const staleReasons = new Set<string>()
      const contentHash = block.provenance?.contentHash
      const resourceRevision = block.provenance?.resourceRevision

      if (block.lifecycle?.stale || block.lifecycle?.expired || block.stale) {
        staleReasons.add('block-marked-stale')
      }

      if (
        resourceRevision &&
        input.resourceState?.revision &&
        resourceRevision !== input.resourceState.revision
      ) {
        staleReasons.add('resource-revision-changed')
      }

      for (const path of filePaths) {
        const resourceItem = resolveResourceItem(input.resourceState, path)
        if (contentHash && resourceItem?.hash && contentHash !== resourceItem.hash) {
          staleReasons.add('file-hash-changed')
        }

        if (resourceRevision && resourceItem?.revision && resourceRevision !== resourceItem.revision) {
          staleReasons.add('file-revision-changed')
        }
      }

      const stale = staleReasons.size > 0
      const node: ContextEvidenceGraphNode = {
        blockId: block.id,
        filePaths,
        contentHash: toOptional(contentHash),
        resourceRevision: toOptional(resourceRevision),
        stale,
        staleReasons: [...staleReasons].sort(),
      }

      nodesByBlockId.set(block.id, node)
      if (stale) staleBlockIds.add(block.id)
    }

    return {
      nodesByBlockId,
      staleBlockIds,
    }
  }
}
