/**
 * Markdown adapter：`MarkdownFileAdapter`，实现注入面的 `FileAdapter`（contract/requires.ts）。
 * 把 ATX 标题（`#` 到 `######`）当作符号，给大纲与目标解析用。
 */

import type { FileAdapter } from '../../contract/requires.js'
import type { AdapterCapability, AdapterKind, ParseInput, ParseResult } from '../../types/adapter.js'

export class MarkdownFileAdapter implements FileAdapter {
  public readonly id = 'core.markdown'
  public readonly kind: AdapterKind = 'text'
  public readonly priority = 20
  public readonly capabilities: AdapterCapability[] = ['read', 'search', 'validate']

  public parse(input: ParseInput): ParseResult {
    const headings = (input.snapshot.content ?? '')
      .split('\n')
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /^#{1,6}\s+/.test(line))
      .map(({ line, i }) => ({ kind: 'heading', name: line.replace(/^#+\s+/, ''), range: { startLine: i + 1, endLine: i + 1 } }))
    return { ok: true, symbols: headings, diagnostics: [] }
  }
}
