/**
 * JSON Patch 补丁策略：`JsonPatchStrategy`，实现注入面的 `PatchStrategy`（contract/requires.ts）。
 * 处理 json_patch 操作：按顺序应用 add / replace / remove，再以两格缩进写回整份文档。
 */

import { isArray, isEmpty, isPlainObject, isUndefined, stringifyPretty } from '@velaros-ai/core'

import type { PatchStrategy } from '../../contract/requires.js'
import type { JsonValue } from '../../types/common.js'
import type { PreparedPatch } from '../../types/edit.js'
import type { PatchStrategyInput } from '../../types/patch.js'
import type { JsonPatch } from '../../types/strategies.js'
import { unifiedDiff } from '../../utils/diff.js'
import { applyJsonPatch, isStrictJsonValue, patchError } from '../../utils/editing/json-patch.js'
import { ProjectError } from '../../utils/errors.js'
import { id } from '../../utils/id.js'
import { countChangedLines } from '../../utils/text.js'

export class JsonPatchStrategy implements PatchStrategy {
  public readonly id = 'core.json-patch'
  public readonly priority = 50

  public canHandle(input: PatchStrategyInput): boolean {
    return input.intent.operation.type === 'json_patch'
  }

  public prepare(input: PatchStrategyInput): PreparedPatch[] {
    const snap = input.snapshot
    if (!snap || isUndefined(snap.content)) {
      throw new ProjectError('TARGET_NOT_FOUND', 'JSON patch 需要文本 snapshot')
    }
    let data: JsonValue
    try {
      data = JSON.parse(snap.content) as JsonValue
    } catch (error) {
      throw new ProjectError('VALIDATION_FAILED', `补丁前 JSON 无效：${(error as Error).message}`)
    }
    if (!isStrictJsonValue(data)) {
      throw new ProjectError(
        'VALIDATION_FAILED',
        '补丁前 JSON 含不能安全写回的非有限数值。',
        { path: snap.path, reason: 'document_not_json_value' },
        '请先把 NaN 或正负 Infinity 改为标准 JSON 值，再准备 JSON Patch。'
      )
    }
    const operation = input.intent.operation
    if (operation.type !== 'json_patch') {
      throw new ProjectError('INVALID_INPUT', 'json patch strategy 收到非 json_patch 操作。')
    }
    const patches: unknown = operation.patches
    if (!isArray(patches) || isEmpty(patches)) {
      patchError(-1, '', 'patches_required', 'patches 必须是非空数组。')
    }
    for (const [patchIndex, rawPatch] of patches.entries()) {
      if (!isPlainObject(rawPatch)) {
        patchError(patchIndex, '', 'invalid_patch', 'patch 必须是对象。')
      }
      const patch = rawPatch as JsonPatch
      if (patch.op !== 'add' && patch.op !== 'replace' && patch.op !== 'remove') {
        patchError(patchIndex, patch.path, 'unsupported_op', `不支持的操作：${String(patch.op)}`)
      }
      data = applyJsonPatch(data, patch, patchIndex)
    }
    const newContent = `${stringifyPretty(data)}\n`
    const diff = unifiedDiff(snap.path, snap.content, newContent)
    const changedLines = countChangedLines(diff)
    const prepared: PreparedPatch = {
      patchId: id('patch'),
      strategyId: this.id,
      path: snap.path,
      baseRevision: snap.revision,
      oldContent: snap.content,
      newContent,
      diff,
      changedLines,
      risk: 'low', // 规模不代表风险,统一 low(真正危险在操作层判定)
    }
    return [prepared]
  }
}
