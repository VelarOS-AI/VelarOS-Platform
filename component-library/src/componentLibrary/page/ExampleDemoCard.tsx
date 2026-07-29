import { memo, type ReactElement } from 'react'

import { Badge } from '@velaros-ai/ui/primitives/display/Badge'

import type { ComponentLibraryEntry } from '../models/componentLibraryTypes'

import { CodeSnippet } from './CodeSnippet'
import { getExampleCode } from './componentLibraryCodegen'
import type { ComponentLibraryTranslate } from './componentLibraryPageTypes'

import styles from '@catalog/styles/ComponentLibraryPage.module.css'

interface ExampleDemoCardProps {
  entry: ComponentLibraryEntry
  example: ComponentLibraryEntry['examples'][number]
  t: ComponentLibraryTranslate
}

export const ExampleDemoCard = memo(function ExampleDemoCard({
  entry,
  example,
  t,
}: ExampleDemoCardProps): ReactElement {
  return (
    <article className={styles.demoCard}>
      <div className={styles.demoCanvas}>{example.node}</div>
      <div className={styles.demoMeta}>
        <div className={styles.demoMetaTitleRow}>
          <span className={styles.demoMetaTitle}>{example.label}</span>
          {example.interactive && (
            <Badge variant="secondary" className={styles.demoMetaBadge}>
              {t('componentLibrary.interactiveDemoBadge')}
            </Badge>
          )}
        </div>
        <details className={styles.demoCodeDetails}>
          <summary>{t('componentLibrary.code')}</summary>
          <CodeSnippet code={getExampleCode(entry, example.label, example.code)} showLineNumbers />
        </details>
      </div>
    </article>
  )
})

ExampleDemoCard.displayName = 'ExampleDemoCard'
