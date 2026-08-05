import {
  type ConversationTranslator,
  conversationTranslatorRuntime,
} from '../i18n/conversationTranslator'

import type { AppLocale, ToolCategoryId, ToolPermission } from '#contracts'
import { toNullable } from '#internal/runtime'

type ToolMessageSection =
  | 'toolDescriptions'
  | 'categoryLabels'
  | 'categoryDescriptions'
  | 'permissionNames'

function readToolMessage(
  locale: AppLocale,
  section: ToolMessageSection,
  id: string,
  runtime: ConversationTranslator
): Nullable<string> {
  // 走注入的目录查询：命中返回文案、真正 miss 返回 null（供 humanize 回落）、调试模式返回 key 路径。
  return runtime.lookupMessage(locale, `tools.${section}.${id}`)
}

export function getToolDescriptionText(
  toolName: string,
  locale: AppLocale,
  fallback?: LooseOptional<string>,
  runtime: ConversationTranslator = conversationTranslatorRuntime
): Nullable<string> {
  return toNullable(readToolMessage(locale, 'toolDescriptions', toolName, runtime) ?? fallback)
}

export function getToolCategoryLabel(
  categoryId: ToolCategoryId,
  locale: AppLocale,
  fallback?: LooseOptional<string>,
  runtime: ConversationTranslator = conversationTranslatorRuntime
): string {
  return readToolMessage(locale, 'categoryLabels', categoryId, runtime) ?? fallback ?? categoryId
}

export function getToolCategoryDescription(
  categoryId: ToolCategoryId,
  locale: AppLocale,
  fallback?: LooseOptional<string>,
  runtime: ConversationTranslator = conversationTranslatorRuntime
): Nullable<string> {
  return toNullable(
    readToolMessage(locale, 'categoryDescriptions', categoryId, runtime) ?? fallback
  )
}

export function getToolPermissionDisplayName(
  permission: ToolPermission,
  locale: AppLocale,
  runtime: ConversationTranslator = conversationTranslatorRuntime
): string {
  return readToolMessage(locale, 'permissionNames', permission, runtime) ?? permission
}
