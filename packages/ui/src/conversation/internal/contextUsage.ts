function estimateTextTokens(text: string): number {
  let tokens = 0
  for (const character of text) {
    if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(character)) tokens += 1
    else if (/\s/u.test(character)) tokens += 0.2
    else tokens += 0.25
  }
  return Math.ceil(tokens)
}

/**
 * Lightweight display-only estimate. Billing/runtime accounting remains an injected DTO and wins
 * whenever available; this fallback intentionally owns no model catalog or tokenizer runtime.
 */
export function estimateContextUsage(
  _model: string,
  systemPrompt: string,
  messages: readonly unknown[]
): { estimatedTokens: number } {
  const serializedMessages = JSON.stringify(messages)
  return { estimatedTokens: estimateTextTokens(`${systemPrompt}\n${serializedMessages}`) }
}
