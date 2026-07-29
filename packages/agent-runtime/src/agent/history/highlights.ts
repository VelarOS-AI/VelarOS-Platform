import { HistoryMessages } from './messages'

const FilePathPattern =
  /\b[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|html|toml|yaml|yml|sql|py|rb|go|rs|java|kt|swift|sh)\b/g

const ModuleNamePattern =
  /\b[A-Za-z][A-Za-z0-9]+(?:Helper|Service|Store|Loop|Coordinator|Tracker|State|Schema|Context|Manager|Broker|Runtime)\b/g

class SummaryHighlights {
  private readonly maxSummaryLength = 220
  private readonly maxFileItemLength = 120

  constructor(private readonly messageHelper = new HistoryMessages()) {}

  public extractDecisionHighlights(texts: string[]): string[] {
    return this.extractSentenceHighlights(texts, (sentence) => this.isDecisionSentence(sentence))
  }

  public extractOpenIssueHighlights(texts: string[]): string[] {
    return this.extractSentenceHighlights(texts, (sentence) => this.isOpenIssueSentence(sentence))
  }

  public extractVerificationHighlights(texts: string[]): string[] {
    return this.extractSentenceHighlights(texts, (sentence) => this.isVerificationSentence(sentence))
  }

  public extractUserConstraintHighlights(texts: string[]): string[] {
    return this.extractSentenceHighlights(texts, (sentence) => this.isUserConstraintSentence(sentence))
  }

  public extractFileHighlights(texts: string[]): string[] {
    const files: string[] = []
    const seen = new Set<string>()

    texts.forEach((text) => {
      const matches = [
        ...text.matchAll(FilePathPattern),
        ...text.matchAll(ModuleNamePattern),
      ]
      matches.forEach((match) => {
        const value = this.messageHelper.previewText(match[0], this.maxFileItemLength)
        if (!value || seen.has(value)) return

        seen.add(value)
        files.push(value)
      })
    })

    return files
  }

  private extractSentenceHighlights(
    texts: string[],
    predicate: (sentence: string) => boolean,
  ): string[] {
    const highlights: string[] = []
    const seen = new Set<string>()

    texts.forEach((text) => {
      this.extractSentences(text).forEach((sentence) => {
        if (!predicate(sentence)) return

        const preview = this.messageHelper.previewText(sentence, this.maxSummaryLength)
        if (!preview || seen.has(preview)) return

        seen.add(preview)
        highlights.push(preview)
      })
    })

    return highlights
  }

  private extractSentences(text: string): string[] {
    return text
      .split(/\n+|\s+\|\s+|(?<=[。！？!?;；])\s+|(?<=\.)\s+(?=[A-Z0-9`'"\u4e00-\u9fff])/u)
      .map((sentence) => sentence.trim())
      .filter(Boolean)
  }

  private isDecisionSentence(sentence: string): boolean {
    const normalized = sentence.toLowerCase()
    return [
      'decision',
      'decided',
      'choose',
      'chosen',
      'switch',
      'migrate',
      'move',
      'store',
      'persist',
      'serialize',
      'rename',
      'require',
      'default',
      'fallback',
      'treat',
      'route',
      'compact',
      'compress',
      'only accept',
      '统一',
      '改成',
      '改为',
      '只认',
      '挪到',
      '移动到',
      '落到',
      '存到',
      '要求',
      '必须',
      '不再',
      '默认',
      '收口',
      '压成',
      '迁移',
      '必传',
    ].some((keyword) => normalized.includes(keyword))
  }

  private isOpenIssueSentence(sentence: string): boolean {
    const normalized = sentence.toLowerCase()
    return [
      'open issue',
      'remaining issue',
      'remaining risk',
      'still ',
      'still`',
      'pending',
      'todo',
      'follow up',
      'blocked',
      'blocker',
      'problem',
      'limitation',
      'risk',
      'not yet',
      'need to',
      'needs ',
      'unable',
      'cannot',
      'failed because',
      '待处理',
      '未解决',
      '还有',
      '仍然',
      '问题',
      '阻塞',
      '限制',
      '后续',
      '还没',
      '待办',
    ].some((keyword) => normalized.includes(keyword))
  }

  private isVerificationSentence(sentence: string): boolean {
    const normalized = sentence.toLowerCase()
    const hasVerificationSubject = [
      'test',
      'typecheck',
      'lint',
      'build',
      'verify',
      'verification',
      'pytest',
      'jest',
      'vitest',
      'tsc',
      'bun run',
      'npm run',
      'pnpm',
      'yarn',
      'cargo test',
      'go test',
    ].some((keyword) => normalized.includes(keyword))

    const hasVerificationOutcome = [
      'ran ',
      ' run ',
      'passed',
      'failed',
      'timed out',
      'success',
      '通过',
      '失败',
      '报错',
      '超时',
      '跑过了',
      '验证',
    ].some((keyword) => normalized.includes(keyword))

    return hasVerificationSubject && hasVerificationOutcome
  }

  private isUserConstraintSentence(sentence: string): boolean {
    const normalized = sentence.toLowerCase()
    return [
      'constraint',
      'requirement',
      'must ',
      'must not',
      'do not',
      "don't",
      'never ',
      'only ',
      'preserve',
      'keep ',
      '不要',
      '不能',
      '不得',
      '必须',
      '只能',
      '只许',
      '保留',
      '禁止',
      '约束',
      '要求',
    ].some((keyword) => normalized.includes(keyword))
  }
}

export { SummaryHighlights }
export { SummaryHighlights as AgentHistorySummaryHighlightHelper }
