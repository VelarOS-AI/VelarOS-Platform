// 域：json_patch 操作的纯实现：JSON Pointer 解析与 add / replace / remove 三种操作（RFC 6902 的子集）。
// 每一步失败都报出是第几个 patch、哪个 path、什么原因，模型据此只修正出错的那一项。
import {
  isArray,
  isBoolean,
  isEmpty,
  isFiniteNumber,
  isNull,
  isObject,
  isPlainObject,
  isString,
  isUndefined,
} from '@velaros-ai/core'

import type { JsonValue } from '../../types/common.js'
import type { JsonContainer, JsonPatch } from '../../types/strategies.js'
import { ProjectError } from '../errors.js'

/** 抛出第 patchIndex 个 patch 的入参错误，带上它的 path 与失败原因。 */
export function patchError(
  patchIndex: number,
  patchPath: unknown,
  reason: string,
  message: string
): never {
  const path = isString(patchPath) ? patchPath : String(patchPath)
  throw new ProjectError(
    'INVALID_INPUT',
    `json_patch[${patchIndex}] ${message}`,
    { patchIndex, path, reason },
    '请修正该 patch 的 JSON Pointer 或操作参数后重新准备事务。'
  )
}

/** 把 JSON Pointer 拆成逐级的键，~1、~0 还原成 / 与 ~；空串指文档根，返回空数组。 */
function pointerParts(pointer: unknown, patchIndex: number): string[] {
  if (!isString(pointer)) {
    patchError(patchIndex, pointer, 'invalid_pointer', 'path 必须是 JSON Pointer 字符串。')
  }
  if (isEmpty(pointer)) return []
  if (!pointer.startsWith('/')) {
    patchError(
      patchIndex,
      pointer,
      'invalid_pointer',
      `JSON Pointer 必须为空字符串或以 / 开头：${pointer}`
    )
  }
  return pointer
    .slice(1)
    .split('/')
    .map((part) => {
      if (/~(?:[^01]|$)/u.test(part)) {
        patchError(
          patchIndex,
          pointer,
          'invalid_pointer_escape',
          `JSON Pointer 含无效 ~ 转义：${pointer}`
        )
      }
      return part.replace(/~1/gu, '/').replace(/~0/gu, '~')
    })
}

/** 值是不是 JSON 数组或普通对象。 */
function isJsonContainer(value: JsonValue): value is JsonContainer {
  return isArray(value) || isPlainObject(value)
}

/** 值是不是能原样写回的严格 JSON：只含 null、字符串、布尔、有限数与普通对象、数组，且没有环。 */
export function isStrictJsonValue(value: unknown): value is JsonValue {
  const seen = new Set<object>()
  const visit = (candidate: unknown): boolean => {
    if (
      isNull(candidate) ||
      isString(candidate) ||
      isBoolean(candidate) ||
      isFiniteNumber(candidate)
    )
      return true
    if (!isObject(candidate)) return false
    if (seen.has(candidate)) return false
    seen.add(candidate)
    if (isArray(candidate)) return candidate.every(visit)
    if (
      Object.getPrototypeOf(candidate) !== Object.prototype &&
      !isNull(Object.getPrototypeOf(candidate))
    )
      return false
    return Object.values(candidate).every(visit)
  }

  return visit(value)
}

/** patch 的 value 必须是严格 JSON，否则按该 patch 的入参错误拒绝。 */
function assertJsonValue(
  value: unknown,
  patchIndex: number,
  path: string
): asserts value is JsonValue {
  if (!isStrictJsonValue(value)) {
    patchError(patchIndex, path, 'value_not_json', 'value 必须是可序列化的有限 JSON 值。')
  }
}

/** 深拷贝一个 JSON 值，写进文档的值不和入参共享引用。 */
function cloneJsonValue(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/** 把 Pointer 里的一段解析成数组下标：只有 add 可以用 - 指末尾，也只有 add 可以指到 length。 */
function arrayIndex(
  token: string,
  length: number,
  mode: JsonPatch['op'],
  patchIndex: number,
  path: string
): number {
  if (token === '-') {
    if (mode === 'add') return length
    patchError(patchIndex, path, 'invalid_array_index', '- 只允许用于 add 到数组末尾。')
  }
  if (!/^(?:0|[1-9]\d*)$/u.test(token)) {
    patchError(patchIndex, path, 'invalid_array_index', `数组索引无效：${token}`)
  }
  const index = Number(token)
  const maximum = mode === 'add' ? length : length - 1
  if (!Number.isSafeInteger(index) || index > maximum) {
    patchError(
      patchIndex,
      path,
      'array_index_out_of_bounds',
      `数组索引越界：${token}（${mode} 允许的最大索引为 ${maximum}）。`
    )
  }
  return index
}

/** 沿 Pointer 走到目标的父节点；中途不存在或不是容器时拒绝。 */
function resolveParent(
  root: JsonValue,
  parts: string[],
  patchIndex: number,
  path: string
): JsonContainer {
  let current = root
  for (const token of parts.slice(0, -1)) {
    if (!isJsonContainer(current)) {
      patchError(patchIndex, path, 'parent_not_container', `路径父节点不是对象或数组：${token}`)
    }
    if (isArray(current)) {
      const index = arrayIndex(token, current.length, 'replace', patchIndex, path)
      current = current[index] as JsonValue
      continue
    }
    if (!Object.hasOwn(current, token)) {
      patchError(patchIndex, path, 'parent_missing', `路径父节点不存在：${token}`)
    }
    current = current[token] as JsonValue
  }
  if (!isJsonContainer(current)) {
    patchError(patchIndex, path, 'parent_not_container', '目标父节点不是对象或数组。')
  }
  return current
}

/** 把第 patchIndex 个 patch 应用到文档上（就地修改），返回新的文档根；替换根节点时返回新值。 */
export function applyJsonPatch(root: JsonValue, patch: JsonPatch, patchIndex: number): JsonValue {
  const parts = pointerParts(patch.path, patchIndex)
  const allowedFields = new Set(patch.op === 'remove' ? ['op', 'path'] : ['op', 'path', 'value'])
  const unexpectedField = Object.keys(patch).find((field) => !allowedFields.has(field))
  if (unexpectedField) {
    patchError(
      patchIndex,
      patch.path,
      'unexpected_field',
      `${patch.op} 含不支持的字段：${unexpectedField}`
    )
  }
  if (patch.op !== 'remove') {
    if (!Object.hasOwn(patch, 'value') || isUndefined(patch.value)) {
      patchError(patchIndex, patch.path, 'value_required', `${patch.op} 必须提供 value。`)
    }
    assertJsonValue(patch.value, patchIndex, patch.path)
  }

  if (isEmpty(parts)) {
    if (patch.op === 'remove') {
      patchError(
        patchIndex,
        patch.path,
        'root_remove_unsupported',
        '不能删除整个 JSON 文档根节点。'
      )
    }
    return cloneJsonValue(patch.value)
  }

  const parent = resolveParent(root, parts, patchIndex, patch.path)
  const token = parts.at(-1)!
  if (isArray(parent)) {
    const index = arrayIndex(token, parent.length, patch.op, patchIndex, patch.path)
    if (patch.op === 'remove') parent.splice(index, 1)
    else if (patch.op === 'add') parent.splice(index, 0, cloneJsonValue(patch.value))
    else parent[index] = cloneJsonValue(patch.value)
    return root
  }

  const targetExists = Object.hasOwn(parent, token)
  if (patch.op !== 'add' && !targetExists) {
    patchError(patchIndex, patch.path, 'target_missing', `${patch.op} 的目标属性不存在：${token}`)
  }
  if (patch.op === 'remove') {
    delete parent[token]
  } else {
    Object.defineProperty(parent, token, {
      value: cloneJsonValue(patch.value),
      configurable: true,
      enumerable: true,
      writable: true,
    })
  }
  return root
}
