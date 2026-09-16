/** 构造轻量页面指纹脚本，用于判断浏览器动作后是否产生可观察变化。 */
class BrowserActionEffectScriptBuilder {
  public buildActionEffectSnapshotScript(): string {
    return `(() => {
      const __velarosActionEffectSnapshot = true
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim()
      const rawText = String(document.body?.innerText || document.documentElement?.textContent || '')
      const sourceText = normalize(rawText)
      const sample = sourceText.slice(0, 8000)
      const textSampleLines = []
      let textSampleLineCount = 0
      for (const rawLine of rawText.split(/\\r?\\n/)) {
        const line = normalize(rawLine)
        if (!line) continue
        textSampleLineCount += 1
        if (textSampleLines.length < 200) textSampleLines.push(line)
      }
      let hash = 0
      for (let index = 0; index < sample.length; index += 1) {
        hash = Math.imul(31, hash) + sample.charCodeAt(index) | 0
      }

      return {
        url: location.href,
        title: document.title || '',
        textHash: Math.abs(hash).toString(36),
        textLength: sourceText.length,
        textSampleLines,
        textSampleTruncated: textSampleLineCount > textSampleLines.length,
        capturedAt: Date.now(),
        marker: __velarosActionEffectSnapshot,
      }
    })()`
  }
}

export { BrowserActionEffectScriptBuilder }
