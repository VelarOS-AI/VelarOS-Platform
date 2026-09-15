/**
 * JSON adapter：`JsonFileAdapter`，实现注入面的 `FileAdapter`（contract/requires.ts）。
 * 解析与校验 .json 文件：能不能按 JSON 解析，失败时给出解析器的报错。
 */

import { AppError } from '@velaros-ai/core/error'

import type { FileAdapter } from '../../contract/requires.js'
import type { AdapterCapability, AdapterKind, AdapterValidateInput, ParseInput, ParseResult } from '../../types/adapter.js'
import type { ValidationResult } from '../../types/validation.js'

export class JsonFileAdapter implements FileAdapter {
  public readonly id = 'core.json'
  public readonly kind: AdapterKind = 'structured-data'
  public readonly priority = 40
  public readonly capabilities: AdapterCapability[] = ['read', 'validate', 'prepare_edit']

  public parse(input: ParseInput): ParseResult {
    const { snapshot } = input
    try {
      JSON.parse(snapshot.content ?? '')
      return { ok: true, diagnostics: [] }
    } catch (error) {
      return {
        ok: false,
        diagnostics: [{ severity: 'error', message: `JSON 解析失败：${AppError.getMessage(error)}`, path: snapshot.path, source: this.id }],
      }
    }
  }

  public validate(input: AdapterValidateInput): ValidationResult {
    const { snapshot, changedContent } = input
    try {
      JSON.parse(changedContent ?? snapshot.content ?? '')
      return { ok: true, diagnostics: [], checks: [{ id: this.id, ok: true }] }
    } catch (error) {
      return {
        ok: false,
        diagnostics: [{ severity: 'error', message: `JSON 校验失败：${AppError.getMessage(error)}`, path: snapshot.path, source: this.id }],
        checks: [{ id: this.id, ok: false }],
      }
    }
  }
}
