/**
 * JS/TS 补丁策略：`JsTsPatchStrategy`，实现注入面的 `PatchStrategy`（contract/requires.ts）。
 * 处理按符号定位的编辑（replace_symbol、insert_*_symbol）与 import 增删；范围全部出自 TypeScript AST。
 * 同一实现以两种身份注册：核心插件的 jsts.patch，TypeScript 插件以更高优先级再注册一份。
 */

import { isPresent } from '@velaros-ai/core'

import type { PatchStrategy } from '../../contract/requires.js'
import type { PreparedPatch } from '../../types/edit.js'
import type { PatchStrategyInput } from '../../types/patch.js'
import type { JsTsPatchStrategyIdentity } from '../../types/strategies.js'
import { planAddImport, planRemoveImport } from '../../utils/editing/import-mutation.js'
import { createTextPatch } from '../../utils/editing/prepared-patch.js'
import { applySourceSplice } from '../../utils/editing/source.js'
import { isSymbolOperation, locateSymbol, symbolSplice } from '../../utils/editing/symbol-edit.js'
import { ProjectError } from '../../utils/errors.js'
import { isJsTsPath } from '../../utils/jsts-ast.js'

export class JsTsPatchStrategy implements PatchStrategy {
  /** 本策略接的操作：四种符号编辑与 import 增删。 */
  private static readonly HandledOperations: ReadonlySet<string> = new Set([
    'replace_symbol',
    'insert_around_symbol',
    'insert_before_symbol',
    'insert_after_symbol',
    'add_import',
    'remove_import',
  ])

  public readonly id: string
  public readonly priority: number

  public constructor(identity: JsTsPatchStrategyIdentity) {
    this.id = identity.id
    this.priority = identity.priority
  }

  public canHandle(input: PatchStrategyInput): boolean {
    return JsTsPatchStrategy.HandledOperations.has(input.intent.operation.type)
  }

  public prepare(input: PatchStrategyInput): PreparedPatch[] {
    const snapshot = input.snapshot
    if (!snapshot || snapshot.isBinary || !isPresent(snapshot.content))
      throw new ProjectError('NOT_SUPPORTED', 'JS/TS patch 需要文本 snapshot')
    // oldContent 用的就是这里确认读到的原文（没有正文的快照在上面就被拒绝），回滚据此写回。
    const content = snapshot.content
    const operation = input.intent.operation
    const targetId = input.intent.targetId

    if (operation.type === 'add_import' || operation.type === 'remove_import') {
      if (!isJsTsPath(snapshot.path))
        throw new ProjectError(
          'NOT_SUPPORTED',
          `${operation.type} 只支持 JS/TS 文件：${snapshot.path}`
        )
      const splice =
        operation.type === 'add_import'
          ? planAddImport(snapshot.path, content, operation)
          : planRemoveImport(snapshot.path, content, operation)
      // 去重命中也产出显式 noop 补丁，而不是空数组——空数组会让该操作从事务里凭空消失。
      if (!splice)
        return [
          createTextPatch(snapshot.path, snapshot.revision, content, content, this.id, {
            op: operation.type,
            noop: true,
          }),
        ]
      return [
        createTextPatch(
          snapshot.path,
          snapshot.revision,
          content,
          applySourceSplice(content, splice),
          this.id,
          {
            op: operation.type,
            startOffset: splice.start,
            endOffset: splice.end,
          }
        ),
      ]
    }
    if (!isSymbolOperation(operation))
      throw new ProjectError('NOT_SUPPORTED', `不支持的 JS/TS 操作：${operation.type}`)

    const located = locateSymbol(input, snapshot, content, operation)
    const splice = symbolSplice(located, operation)
    return [
      createTextPatch(
        snapshot.path,
        snapshot.revision,
        content,
        applySourceSplice(content, splice),
        this.id,
        {
          op: operation.type,
          mode: operation.type === 'replace_symbol' ? (operation.mode ?? 'whole') : undefined,
          targetId,
          startOffset: splice.start,
          endOffset: splice.end,
        }
      ),
    ]
  }
}
