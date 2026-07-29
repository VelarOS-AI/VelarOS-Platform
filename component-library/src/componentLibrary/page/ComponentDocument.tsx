import { memo, type ReactElement } from 'react'
import { isEmpty } from '@catalog/catalogPrimitives'
import { Streamdown } from 'streamdown'

import {
  resolveStreamdownMarkdownMode,
  STREAMDOWN_MARKDOWN_CONTROLS,
  STREAMDOWN_MARKDOWN_LINK_SAFETY,
  STREAMDOWN_MARKDOWN_PLUGINS,
} from '@velaros-ai/ui/conversation/markdown/streamdownMarkdown.config'
import { List } from '@velaros-ai/ui/primitives/layout/List'

import { resolveComponentLibraryEntryDisplayName } from '../models/componentLibraryLocalization'

import { CodeSnippet } from './CodeSnippet'
import { ComponentApiTable } from './ComponentApiTable'
import { getImportCode } from './componentLibraryCodegen'
import {
  getGeneralUsageExamples,
  getRecommendedUsageExamples,
} from './componentLibraryExampleSections'
import { formatLayer } from './componentLibraryFormatters'
import type {
  ComponentLibraryListEntry,
  ComponentLibraryTranslate,
} from './componentLibraryPageTypes'
import { ComponentRecommendationList } from './ComponentRecommendationList'
import { ExampleDemoCard } from './ExampleDemoCard'

import styles from '@catalog/styles/ComponentLibraryPage.module.css'

interface ComponentDocumentProps {
  listEntry: ComponentLibraryListEntry
  t: ComponentLibraryTranslate
}

export const ComponentDocument = memo(function ComponentDocument({
  listEntry,
  t,
}: ComponentDocumentProps): ReactElement {
  const { section, entry } = listEntry
  const recommendedExamples = getRecommendedUsageExamples(entry)
  const generalExamples = getGeneralUsageExamples(entry)
  const hasRecommendations = !!entry.recommendations && !isEmpty(entry.recommendations)
  const showRecommendedSection = hasRecommendations || !isEmpty(recommendedExamples)
  const showGeneralSection = !isEmpty(generalExamples)
  const entryDisplayLabel = resolveComponentLibraryEntryDisplayName(t, entry.id, entry.name)

  return (
    <article className={styles.doc} aria-label={entryDisplayLabel}>
      <header className={styles.docHeader}>
        <span className={styles.docCategory}>{section.title}</span>
        <h1 className={styles.docTitle}>{entryDisplayLabel}</h1>
        <p className={styles.docMetaLine}>
          <span>{entry.domain}</span>
          <span aria-hidden> · </span>
          <span>{formatLayer(entry.layer, t)}</span>
        </p>
      </header>

      <section id="import" className={styles.docSection}>
        <h2>{t('componentLibrary.importUsage')}</h2>
        <CodeSnippet code={getImportCode(entry)} />
      </section>

      <section id="usage" className={styles.docSection}>
        <h2>{t('componentLibrary.whenToUse')}</h2>
        <div className={styles.usageGrid}>
          <div className={styles.usagePanel}>
            <span>{t('componentLibrary.whenToUse')}</span>
            <p>{entry.usage}</p>
          </div>
          <div className={styles.usagePanel}>
            <span>{t('componentLibrary.avoid')}</span>
            <p>{entry.avoid}</p>
          </div>
        </div>
      </section>

      {!!entry.documentation && (
        <section id="documentation" className={styles.docSection}>
          <h2>{t('componentLibrary.documentation')}</h2>
          <div className={styles.docMarkdown}>
            <Streamdown
              mode={resolveStreamdownMarkdownMode({ isStreaming: false })}
              plugins={STREAMDOWN_MARKDOWN_PLUGINS}
              controls={STREAMDOWN_MARKDOWN_CONTROLS}
              linkSafety={STREAMDOWN_MARKDOWN_LINK_SAFETY}
              className="space-y-0"
            >
              {entry.documentation}
            </Streamdown>
          </div>
        </section>
      )}

      {showRecommendedSection && (
        <section id="recommended" className={styles.docSection}>
          <h2>{t('componentLibrary.recommendedUsage')}</h2>
          <p className={styles.docSectionLead}>{t('componentLibrary.recommendedUsageLead')}</p>
          {hasRecommendations && (
            <ComponentRecommendationList recommendations={entry.recommendations ?? []} />
          )}
          {!!recommendedExamples.length && (
            <>
              {hasRecommendations && (
                <h3 className={styles.docSubheading}>
                  {t('componentLibrary.recommendedLivePreview')}
                </h3>
              )}
              <div className={styles.demoGrid}>
                <List
                  items={recommendedExamples}
                  keyExtractor={(example) => example.id}
                  wrapper="fragment"
                  renderItem={(example) => (
                    <ExampleDemoCard entry={entry} example={example} t={t} />
                  )}
                />
              </div>
            </>
          )}
        </section>
      )}

      {showGeneralSection && (
        <section id="general" className={styles.docSection}>
          <h2>{t('componentLibrary.generalUsage')}</h2>
          <p className={styles.docSectionLead}>{t('componentLibrary.generalUsageLead')}</p>
          <div className={styles.demoGrid}>
            <List
              items={generalExamples}
              keyExtractor={(example) => example.id}
              wrapper="fragment"
              renderItem={(example) => <ExampleDemoCard entry={entry} example={example} t={t} />}
            />
          </div>
        </section>
      )}

      <section id="api" className={styles.docSection}>
        <h2>{t('componentLibrary.propsApi')}</h2>
        <ComponentApiTable entry={entry} t={t} />
      </section>
    </article>
  )
})

ComponentDocument.displayName = 'ComponentDocument'
