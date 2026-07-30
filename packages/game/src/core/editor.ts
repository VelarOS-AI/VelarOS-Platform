import type { AppliedAdjustment } from '@velaros-ai/core/utils/ForgivingSchema'

import { formatGameManifest } from './formatter.js'
import {
  GameManifestError,
  parseGameAssetsManifestText,
  parseGamePrefabManifestText,
  parseGameProjectManifestText,
  parseGameSceneManifestText,
} from './manifest-parser.js'
import {
  GameProjectRelativePathSchema,
  type GameReference,
  gameReferenceId,
} from './references.js'
import {
  applyGameMergePatch,
  GameManifestResolver,
  type GameManifestSourceSet,
} from './resolver.js'
import type {
  GameAssetManifest,
  GameAssetsManifest,
  GameEntityManifest,
  GamePrefabManifest,
  GameProjectManifest,
  GameSceneManifest,
} from './schemas.js'

export type GameManifestEditTarget =
  | 'assets'
  | 'project'
  | GameReference<'prefab'>
  | GameReference<'scene'>

export type GameManifestEditOperation =
  | {
      readonly action: 'set_entity'
      readonly entityId: string
      readonly from?: GameReference<'prefab'> | null
      readonly components?: Readonly<Record<string, unknown>>
    }
  | { readonly action: 'remove_entity'; readonly entityId: string }
  | { readonly action: 'rename_entity'; readonly entityId: string; readonly newId: string }
  | {
      readonly action: 'set_component'
      readonly entityId?: string
      readonly component: string
      readonly values: Readonly<Record<string, unknown>>
    }
  | {
      readonly action: 'remove_component'
      readonly entityId?: string
      readonly component: string
    }
  | { readonly action: 'set_scene_meta'; readonly values: Readonly<Record<string, unknown>> }
  | {
      readonly action: 'set_asset'
      readonly assetId: string
      readonly values: Readonly<Record<string, unknown>>
    }
  | { readonly action: 'remove_asset'; readonly assetId: string }
  | { readonly action: 'set_project'; readonly values: Readonly<Record<string, unknown>> }

export interface GameManifestEditRequest {
  readonly target: GameManifestEditTarget
  readonly operations: readonly GameManifestEditOperation[]
  readonly reason?: string
  readonly dryRun?: boolean
}

export interface GameManifestEditResult {
  readonly ok: true
  readonly target: GameManifestEditTarget
  readonly changedFiles: readonly string[]
  readonly operationsApplied: number
  readonly diffSummary: readonly string[]
  readonly warnings: readonly string[]
  readonly appliedAdjustments: readonly AppliedAdjustment[]
  readonly dryRun: boolean
}

export interface GameManifestDocument {
  readonly path: string
  readonly text: string
  readonly revision: string
}

export interface GameManifestDocumentChange {
  readonly path: string
  readonly text: string
  readonly expectedRevision: string
}

/**
 * Host-owned project-root-confined storage.
 *
 * Implementations must reject absolute/traversing paths and commit writeBatch atomically.
 * The editor supplies the revision it read so concurrent human/agent edits fail closed.
 */
export interface GameManifestDocumentStore {
  readonly read: (path: string) => Promise<GameManifestDocument | null>
  readonly list: (directory: 'prefabs') => Promise<readonly GameManifestDocument[]>
  readonly writeBatch: (changes: readonly GameManifestDocumentChange[]) => Promise<void>
}

export interface GameSceneEditorPort {
  readonly isAvailable: () => boolean
  readonly edit: (request: GameManifestEditRequest) => Promise<GameManifestEditResult>
}

interface ParsedDocument<T> {
  readonly document: GameManifestDocument
  value: T
}

interface LoadedWorkspace {
  project: ParsedDocument<GameProjectManifest>
  scenes: Array<ParsedDocument<GameSceneManifest>>
  prefabs: Array<ParsedDocument<GamePrefabManifest>>
  prefabCandidates: Map<string, GameManifestDocument>
  initialPrefabPaths: Set<string>
  assets: ParsedDocument<GameAssetsManifest>
  warnings: string[]
  adjustments: AppliedAdjustment[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneRecord<T>(value: T): T {
  return structuredClone(value)
}

function withoutKey(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([candidate]) => candidate !== key),
  )
}

function requireDocument(
  document: GameManifestDocument | null,
  path: string,
): GameManifestDocument {
  if (document) {
    if (document.path !== path) {
      throw new GameManifestError(
        'INVALID_MANIFEST',
        `文档存储读取 ${path} 时返回了不匹配的路径 ${document.path}。`,
        {
          path,
          hint: '宿主文档端口必须保持请求路径与返回路径一一对应。',
        },
      )
    }
    return document
  }
  throw new GameManifestError('INVALID_REFERENCE', `找不到游戏清单 ${path}。`, {
    path,
    hint: '先读取 game.project.json，确认工程清单声明的相对路径仍存在。',
  })
}

function assertProjectDocumentPath(path: string, expectedDirectory?: string): void {
  if (
    !GameProjectRelativePathSchema.safeParse(path).success ||
    (expectedDirectory !== undefined &&
      !path.startsWith(`${expectedDirectory}/`))
  ) {
    throw new GameManifestError(
      'INVALID_MANIFEST',
      `宿主返回了工程边界外的清单路径 ${path}。`,
      {
        path,
        hint: '文档存储端口必须把 list/read 结果限制在当前游戏工程根内。',
      },
    )
  }
}

function summary(action: string, target: string): string {
  return `${action}: ${target}`
}

function requireSceneEntity(scene: GameSceneManifest, entityId: string): GameEntityManifest {
  const entity = scene.entities.find((candidate) => candidate.id === entityId)
  if (entity) return entity
  throw new GameManifestError(
    'INVALID_REFERENCE',
    `scene:${scene.id} 中找不到 entity:${entityId}。`,
    {
      hint: `可用 entity id：${
        scene.entities.map((candidate) => candidate.id).join(', ') || '当前为空'
      }`,
    },
  )
}

function requireEntityId(
  operation: { readonly action: string; readonly entityId?: string },
  target: string,
): string {
  if (operation.entityId) return operation.entityId
  throw new GameManifestError(
    'INVALID_MANIFEST',
    `${operation.action} 作用于 ${target} 时必须提供 entityId。`,
  )
}

function replaceEntityReferences(
  value: unknown,
  oldReference: GameReference<'entity'>,
  nextReference: GameReference<'entity'>,
): unknown {
  if (value === oldReference) return nextReference
  if (Array.isArray(value)) return value.map((item) => replaceEntityReferences(item, oldReference, nextReference))
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      replaceEntityReferences(nested, oldReference, nextReference),
    ]),
  )
}

function sceneDescendsFrom(
  scene: GameSceneManifest,
  ancestorId: string,
  index: ReadonlyMap<string, GameSceneManifest>,
): boolean {
  const seen = new Set<string>()
  let current = scene
  while (current.extends) {
    const parentId = gameReferenceId(current.extends)
    if (parentId === ancestorId) return true
    if (seen.has(parentId)) return false
    seen.add(parentId)
    const parent = index.get(parentId)
    if (!parent) return false
    current = parent
  }
  return false
}

function collectParseResult(
  workspace: LoadedWorkspace,
  result: {
    readonly warnings: readonly string[]
    readonly appliedAdjustments: readonly AppliedAdjustment[]
  },
): void {
  workspace.warnings.push(...result.warnings)
  workspace.adjustments.push(...result.appliedAdjustments)
}

function sourceSet(workspace: LoadedWorkspace): GameManifestSourceSet {
  const declaredPrefabPaths = new Set(workspace.project.value.prefabs)
  return {
    project: workspace.project.value,
    scenes: workspace.scenes.map((entry) => entry.value),
    prefabs: workspace.prefabs
      .filter((entry) => declaredPrefabPaths.has(entry.document.path))
      .map((entry) => entry.value),
    assets: workspace.assets.value,
  }
}

function serializeWorkspace(workspace: LoadedWorkspace): Map<string, string> {
  return new Map([
    [workspace.project.document.path, formatGameManifest(workspace.project.value)],
    ...workspace.scenes.map(
      (entry) =>
        [entry.document.path, formatGameManifest(entry.value)] as const,
    ),
    ...[...workspace.prefabCandidates.values()].map(
      (document) => [document.path, document.text] as const,
    ),
    ...workspace.prefabs.map(
      (entry) => [
        entry.document.path,
        workspace.initialPrefabPaths.has(entry.document.path)
          ? formatGameManifest(entry.value)
          : entry.document.text,
      ] as const,
    ),
    [workspace.assets.document.path, formatGameManifest(workspace.assets.value)],
  ])
}

function manifestEntry(
  workspace: LoadedWorkspace,
  target: GameManifestEditTarget,
):
  | ParsedDocument<GameAssetsManifest>
  | ParsedDocument<GamePrefabManifest>
  | ParsedDocument<GameProjectManifest>
  | ParsedDocument<GameSceneManifest> {
  if (target === 'project') return workspace.project
  if (target === 'assets') return workspace.assets
  const id = gameReferenceId(target)
  const entry = target.startsWith('scene:')
    ? workspace.scenes.find((candidate) => candidate.value.id === id)
    : workspace.prefabs.find((candidate) => candidate.value.id === id)
  if (
    entry &&
    (
      target.startsWith('scene:') ||
      workspace.project.value.prefabs.includes(entry.document.path)
    )
  ) return entry
  throw new GameManifestError('INVALID_REFERENCE', `找不到编辑目标 ${target}。`, {
    hint: target.startsWith('scene:')
      ? `可用 scene：${
          workspace.scenes
            .map((candidate) => `scene:${candidate.value.id}`)
            .join(', ') || '当前为空'
        }`
      : `可用 prefab：${
          workspace.prefabs
            .map((candidate) => `prefab:${candidate.value.id}`)
            .join(', ') || '当前为空'
        }`,
  })
}

export class GameManifestWorkspaceEditor implements GameSceneEditorPort {
  public constructor(private readonly store: GameManifestDocumentStore) {}

  public isAvailable(): boolean {
    return true
  }

  public async edit(request: GameManifestEditRequest): Promise<GameManifestEditResult> {
    const workspace = await this.loadWorkspace()
    const before = serializeWorkspace(workspace)
    const diffSummary: string[] = []

    // A no-op is still an edit request against a concrete manifest. Validate the
    // target before applying operations so undeclared prefabs cannot use an empty
    // batch to bypass the project's explicit activation list.
    manifestEntry(workspace, request.target)
    for (const operation of request.operations) {
      this.applyOperation(workspace, request.target, operation, diffSummary)
    }

    await this.reparseChangedWorkspace(workspace)
    this.validateDocumentTopology(workspace)
    new GameManifestResolver(sourceSet(workspace)).validate()

    const after = serializeWorkspace(workspace)
    const documents = [
      workspace.project.document,
      ...workspace.scenes.map((entry) => entry.document),
      ...workspace.prefabs.map((entry) => entry.document),
      workspace.assets.document,
    ]
    const changes = documents.flatMap((document): GameManifestDocumentChange[] => {
      const next = after.get(document.path)
      if (
        next === undefined ||
        !before.has(document.path) ||
        next === before.get(document.path)
      ) return []
      return [{ path: document.path, text: next, expectedRevision: document.revision }]
    })

    if (!request.dryRun && changes.length > 0) {
      await this.store.writeBatch(changes)
    }

    return {
      ok: true,
      target: request.target,
      changedFiles: changes.map((change) => change.path),
      operationsApplied: request.operations.length,
      diffSummary,
      warnings: [...new Set(workspace.warnings)],
      appliedAdjustments: workspace.adjustments,
      dryRun: request.dryRun ?? false,
    }
  }

  private async loadWorkspace(): Promise<LoadedWorkspace> {
    const projectDocument = requireDocument(
      await this.store.read('game.project.json'),
      'game.project.json',
    )
    const projectResult = parseGameProjectManifestText(
      projectDocument.text,
      projectDocument.path,
    )
    const workspace: LoadedWorkspace = {
      project: { document: projectDocument, value: cloneRecord(projectResult.value) },
      scenes: [],
      prefabs: [],
      prefabCandidates: new Map(),
      initialPrefabPaths: new Set(projectResult.value.prefabs),
      assets: {} as ParsedDocument<GameAssetsManifest>,
      warnings: [...projectResult.warnings],
      adjustments: [...projectResult.appliedAdjustments],
    }

    for (const scenePath of projectResult.value.scenes) {
      const document = requireDocument(await this.store.read(scenePath), scenePath)
      const parsed = parseGameSceneManifestText(document.text, document.path)
      workspace.scenes.push({ document, value: cloneRecord(parsed.value) })
      collectParseResult(workspace, parsed)
    }

    const declaredPrefabPaths = new Set(projectResult.value.prefabs)
    for (const document of await this.store.list('prefabs')) {
      if (!document.path.endsWith('.prefab.json')) continue
      assertProjectDocumentPath(document.path, 'prefabs')
      workspace.prefabCandidates.set(document.path, document)
      if (!declaredPrefabPaths.has(document.path)) continue
      const parsed = parseGamePrefabManifestText(document.text, document.path)
      workspace.prefabs.push({ document, value: cloneRecord(parsed.value) })
      collectParseResult(workspace, parsed)
    }

    const assetsDocument = requireDocument(
      await this.store.read(projectResult.value.assets),
      projectResult.value.assets,
    )
    const assetsResult = parseGameAssetsManifestText(
      assetsDocument.text,
      assetsDocument.path,
    )
    workspace.assets = {
      document: assetsDocument,
      value: cloneRecord(assetsResult.value),
    }
    collectParseResult(workspace, assetsResult)
    return workspace
  }

  private validateDocumentTopology(workspace: LoadedWorkspace): void {
    const loadedScenePaths = new Set(
      workspace.scenes.map((entry) => entry.document.path),
    )
    for (const scenePath of workspace.project.value.scenes) {
      if (loadedScenePaths.has(scenePath)) continue
      throw new GameManifestError(
        'INVALID_REFERENCE',
        `project.scenes 新增了尚不存在的清单 ${scenePath}。`,
        {
          path: 'game.project.json',
          hint: '先用工作区工具创建并校验新场景文件，再把它加入 project.scenes。',
        },
      )
    }
    if (workspace.project.value.assets !== workspace.assets.document.path) {
      throw new GameManifestError(
        'INVALID_REFERENCE',
        `project.assets 指向尚未加载的 ${workspace.project.value.assets}。`,
        {
          path: 'game.project.json',
          hint: '先用工作区工具创建资产清单，再修改 project.assets。',
        },
      )
    }
    const loadedPrefabPaths = new Set(
      workspace.prefabs.map((entry) => entry.document.path),
    )
    for (const prefabPath of workspace.project.value.prefabs) {
      if (loadedPrefabPaths.has(prefabPath)) continue
      throw new GameManifestError(
        'INVALID_REFERENCE',
        `project.prefabs 新增了尚不存在的清单 ${prefabPath}。`,
        {
          path: 'game.project.json',
          hint: '先用工作区工具创建并校验 prefab 文件，再把它加入 project.prefabs。',
        },
      )
    }
  }

  private async reparseChangedWorkspace(workspace: LoadedWorkspace): Promise<void> {
    const project = parseGameProjectManifestText(
      formatGameManifest(workspace.project.value),
      workspace.project.document.path,
    )
    workspace.project.value = project.value
    collectParseResult(workspace, project)
    await this.activateDeclaredScenesAndAssets(workspace)
    this.activateDeclaredPrefabs(workspace)

    for (const entry of workspace.scenes) {
      const parsed = parseGameSceneManifestText(
        formatGameManifest(entry.value),
        entry.document.path,
      )
      entry.value = parsed.value
      collectParseResult(workspace, parsed)
    }
    for (const entry of workspace.prefabs) {
      const parsed = parseGamePrefabManifestText(
        formatGameManifest(entry.value),
        entry.document.path,
      )
      entry.value = parsed.value
      collectParseResult(workspace, parsed)
    }
    const assets = parseGameAssetsManifestText(
      formatGameManifest(workspace.assets.value),
      workspace.assets.document.path,
    )
    workspace.assets.value = assets.value
    collectParseResult(workspace, assets)
  }

  private async activateDeclaredScenesAndAssets(
    workspace: LoadedWorkspace,
  ): Promise<void> {
    const activeScenesByPath = new Map(
      workspace.scenes.map((entry) => [entry.document.path, entry]),
    )
    const scenes: Array<ParsedDocument<GameSceneManifest>> = []
    for (const scenePath of workspace.project.value.scenes) {
      const active = activeScenesByPath.get(scenePath)
      if (active) {
        scenes.push(active)
        continue
      }
      const document = await this.store.read(scenePath)
      if (!document) {
        throw new GameManifestError(
          'INVALID_REFERENCE',
          `project.scenes 新增了尚不存在的清单 ${scenePath}。`,
          {
            path: 'game.project.json',
            hint: '先用工作区工具创建并校验新场景文件，再把它加入 project.scenes。',
          },
        )
      }
      assertProjectDocumentPath(document.path, 'scenes')
      if (document.path !== scenePath) {
        throw new GameManifestError(
          'INVALID_MANIFEST',
          `文档存储读取 ${scenePath} 时返回了不匹配的路径 ${document.path}。`,
          {
            path: scenePath,
            hint: '宿主文档端口必须保持请求路径与返回路径一一对应。',
          },
        )
      }
      const parsed = parseGameSceneManifestText(document.text, document.path)
      collectParseResult(workspace, parsed)
      scenes.push({ document, value: cloneRecord(parsed.value) })
    }
    workspace.scenes = scenes

    const assetsPath = workspace.project.value.assets
    if (workspace.assets.document.path === assetsPath) return
    const document = await this.store.read(assetsPath)
    if (!document) {
      throw new GameManifestError(
        'INVALID_REFERENCE',
        `project.assets 指向尚不存在的清单 ${assetsPath}。`,
        {
          path: 'game.project.json',
          hint: '先用工作区工具创建并校验资产清单，再修改 project.assets。',
        },
      )
    }
    assertProjectDocumentPath(document.path, 'assets')
    if (document.path !== assetsPath) {
      throw new GameManifestError(
        'INVALID_MANIFEST',
        `文档存储读取 ${assetsPath} 时返回了不匹配的路径 ${document.path}。`,
        {
          path: assetsPath,
          hint: '宿主文档端口必须保持请求路径与返回路径一一对应。',
        },
      )
    }
    const parsed = parseGameAssetsManifestText(document.text, document.path)
    collectParseResult(workspace, parsed)
    workspace.assets = { document, value: cloneRecord(parsed.value) }
  }

  private activateDeclaredPrefabs(workspace: LoadedWorkspace): void {
    const activeByPath = new Map(
      workspace.prefabs.map((entry) => [entry.document.path, entry]),
    )
    workspace.prefabs = workspace.project.value.prefabs.map((prefabPath) => {
      const active = activeByPath.get(prefabPath)
      if (active) return active
      const document = workspace.prefabCandidates.get(prefabPath)
      if (!document) {
        throw new GameManifestError(
          'INVALID_REFERENCE',
          `project.prefabs 新增了尚不存在的清单 ${prefabPath}。`,
          {
            path: 'game.project.json',
            hint: '先用工作区工具创建并校验 prefab 文件，再把它加入 project.prefabs。',
          },
        )
      }
      const parsed = parseGamePrefabManifestText(document.text, document.path)
      collectParseResult(workspace, parsed)
      return { document, value: cloneRecord(parsed.value) }
    })
  }

  private applyOperation(
    workspace: LoadedWorkspace,
    target: GameManifestEditTarget,
    operation: GameManifestEditOperation,
    summaries: string[],
  ): void {
    const targetEntry = manifestEntry(workspace, target)

    switch (operation.action) {
      case 'set_entity': {
        if (!target.startsWith('scene:')) {
          throw new GameManifestError(
            'INVALID_MANIFEST',
            'set_entity 只能用于 scene:<id>。',
          )
        }
        const scene = targetEntry.value as GameSceneManifest
        const index = scene.entities.findIndex(
          (entity) => entity.id === operation.entityId,
        )
        const patch = {
          id: operation.entityId,
          ...(operation.from === undefined ? {} : { from: operation.from }),
          ...(operation.components === undefined
            ? {}
            : { components: operation.components }),
        }
        if (index < 0) scene.entities.push(patch)
        else {
          scene.entities[index] = applyGameMergePatch(
            scene.entities[index],
            { ...patch, remove: null },
          ) as GameEntityManifest
        }
        summaries.push(
          summary(
            index < 0 ? 'added entity' : 'updated entity',
            `entity:${operation.entityId}`,
          ),
        )
        return
      }
      case 'remove_entity': {
        if (!target.startsWith('scene:')) {
          throw new GameManifestError(
            'INVALID_MANIFEST',
            'remove_entity 只能用于 scene:<id>。',
          )
        }
        const scene = targetEntry.value as GameSceneManifest
        const index = scene.entities.findIndex(
          (entity) => entity.id === operation.entityId,
        )
        const inheritedEntity = scene.extends
          ? new GameManifestResolver(sourceSet(workspace))
              .resolveScene(gameReferenceId(scene.extends))
              .entities.some((entity) => entity.id === operation.entityId)
          : false
        if (inheritedEntity) {
          const tombstone: GameEntityManifest = {
            id: operation.entityId,
            remove: true,
          }
          if (index < 0) scene.entities.push(tombstone)
          else scene.entities[index] = tombstone
        } else {
          if (index < 0) requireSceneEntity(scene, operation.entityId)
          scene.entities.splice(index, 1)
        }
        summaries.push(summary('removed entity', `entity:${operation.entityId}`))
        return
      }
      case 'rename_entity': {
        if (!target.startsWith('scene:')) {
          throw new GameManifestError(
            'INVALID_MANIFEST',
            'rename_entity 只能用于 scene:<id>。',
          )
        }
        this.renameEntity(
          workspace,
          targetEntry.value as GameSceneManifest,
          operation.entityId,
          operation.newId,
        )
        summaries.push(
          summary(
            'renamed entity',
            `entity:${operation.entityId} -> entity:${operation.newId}`,
          ),
        )
        return
      }
      case 'set_component': {
        if (target.startsWith('scene:')) {
          const scene = targetEntry.value as GameSceneManifest
          const entity = requireSceneEntity(
            scene,
            requireEntityId(operation, target),
          )
          const current = entity.components?.[operation.component]
          const next = applyGameMergePatch(current ?? {}, operation.values)
          entity.components = {
            ...(entity.components ?? {}),
            ...(next === undefined ? {} : { [operation.component]: next }),
          }
          summaries.push(
            summary(
              'updated component',
              `${target}/entity:${entity.id}/${operation.component}`,
            ),
          )
          return
        }
        if (target.startsWith('prefab:')) {
          if (operation.entityId !== undefined) {
            throw new GameManifestError(
              'INVALID_MANIFEST',
              'prefab 的 set_component 不接收 entityId；target 已唯一指定 prefab。',
            )
          }
          const prefab = targetEntry.value as GamePrefabManifest
          const next = applyGameMergePatch(
            prefab.components[operation.component] ?? {},
            operation.values,
          )
          if (next !== undefined) {
            prefab.components = {
              ...prefab.components,
              [operation.component]: next,
            }
          }
          summaries.push(
            summary('updated component', `${target}/${operation.component}`),
          )
          return
        }
        throw new GameManifestError(
          'INVALID_MANIFEST',
          'set_component 只能用于 scene:<id> 或 prefab:<id>。',
        )
      }
      case 'remove_component': {
        if (target.startsWith('scene:')) {
          const scene = targetEntry.value as GameSceneManifest
          const entity = requireSceneEntity(
            scene,
            requireEntityId(operation, target),
          )
          if (entity.components) {
            entity.components = withoutKey(
              entity.components,
              operation.component,
            )
          }
          summaries.push(
            summary(
              'removed component',
              `${target}/entity:${entity.id}/${operation.component}`,
            ),
          )
          return
        }
        if (target.startsWith('prefab:')) {
          if (operation.entityId !== undefined) {
            throw new GameManifestError(
              'INVALID_MANIFEST',
              'prefab 的 remove_component 不接收 entityId；target 已唯一指定 prefab。',
            )
          }
          const prefab = targetEntry.value as GamePrefabManifest
          prefab.components = withoutKey(prefab.components, operation.component)
          summaries.push(
            summary('removed component', `${target}/${operation.component}`),
          )
          return
        }
        throw new GameManifestError(
          'INVALID_MANIFEST',
          'remove_component 只能用于 scene:<id> 或 prefab:<id>。',
        )
      }
      case 'set_scene_meta': {
        if (!target.startsWith('scene:')) {
          throw new GameManifestError(
            'INVALID_MANIFEST',
            'set_scene_meta 只能用于 scene:<id>。',
          )
        }
        const scene = targetEntry.value as GameSceneManifest
        scene.meta = applyGameMergePatch(
          scene.meta ?? {},
          operation.values,
        ) as GameSceneManifest['meta']
        summaries.push(summary('updated scene meta', target))
        return
      }
      case 'set_asset': {
        if (target !== 'assets') {
          throw new GameManifestError(
            'INVALID_MANIFEST',
            'set_asset 只能用于 assets。',
          )
        }
        const assets = (targetEntry.value as GameAssetsManifest).assets
        const index = assets.findIndex((asset) => asset.id === operation.assetId)
        const next = applyGameMergePatch(
          index < 0 ? { id: operation.assetId } : assets[index],
          operation.values,
        ) as GameAssetManifest
        if (index < 0) assets.push(next)
        else assets[index] = next
        summaries.push(
          summary(
            index < 0 ? 'added asset' : 'updated asset',
            `asset:${operation.assetId}`,
          ),
        )
        return
      }
      case 'remove_asset': {
        if (target !== 'assets') {
          throw new GameManifestError(
            'INVALID_MANIFEST',
            'remove_asset 只能用于 assets。',
          )
        }
        const assets = (targetEntry.value as GameAssetsManifest).assets
        const index = assets.findIndex((asset) => asset.id === operation.assetId)
        if (index < 0) {
          throw new GameManifestError(
            'INVALID_REFERENCE',
            `找不到 asset:${operation.assetId}。`,
            {
              hint: `可用 asset id：${
                assets.map((asset) => asset.id).join(', ') || '当前为空'
              }`,
            },
          )
        }
        assets.splice(index, 1)
        summaries.push(summary('removed asset', `asset:${operation.assetId}`))
        return
      }
      case 'set_project': {
        if (target !== 'project') {
          throw new GameManifestError(
            'INVALID_MANIFEST',
            'set_project 只能用于 project。',
          )
        }
        workspace.project.value = applyGameMergePatch(
          workspace.project.value,
          operation.values,
        ) as GameProjectManifest
        summaries.push(summary('updated project', 'game.project.json'))
      }
    }
  }

  private renameEntity(
    workspace: LoadedWorkspace,
    targetScene: GameSceneManifest,
    entityId: string,
    nextId: string,
  ): void {
    const target = requireSceneEntity(targetScene, entityId)
    if (targetScene.entities.some((entity) => entity.id === nextId)) {
      throw new GameManifestError(
        'INVALID_MANIFEST',
        `scene:${targetScene.id} 已存在 entity:${nextId}，不能重命名为重复 id。`,
      )
    }

    const sceneIndex = new Map(
      workspace.scenes.map((entry) => [entry.value.id, entry.value]),
    )
    const affectedScenes = workspace.scenes
      .map((entry) => entry.value)
      .filter(
        (scene) =>
          scene.id === targetScene.id ||
          sceneDescendsFrom(scene, targetScene.id, sceneIndex),
      )
    const oldReference = `entity:${entityId}` as const
    const nextReference = `entity:${nextId}` as const

    target.id = nextId
    for (const scene of affectedScenes) {
      const replaced = replaceEntityReferences(
        scene,
        oldReference,
        nextReference,
      ) as GameSceneManifest
      scene.meta = replaced.meta
      scene.entities = replaced.entities.map((entity) =>
        scene !== targetScene && entity.id === entityId
          ? { ...entity, id: nextId }
          : entity,
      )
    }
  }
}
