import { memo, type ReactElement } from 'react'

import { List } from '@velaros-ai/ui/primitives/layout/List'

import type { ComponentLibraryRecommendation } from '../models/componentLibraryTypes'

import { CodeSnippet } from './CodeSnippet'

import styles from '@catalog/styles/ComponentLibraryPage.module.css'

interface ComponentRecommendationListProps {
  recommendations: ComponentLibraryRecommendation[]
}

export const ComponentRecommendationList = memo(function ComponentRecommendationList({
  recommendations,
}: ComponentRecommendationListProps): ReactElement {
  return (
    <div className={styles.recommendationGrid}>
      <List
        items={recommendations}
        keyExtractor={(recommendation) => recommendation.id}
        wrapper="fragment"
        renderItem={(recommendation) => (
          <article className={styles.recommendationCard}>
            <div className={styles.recommendationHeader}>
              <span>{recommendation.title}</span>
              <p>{recommendation.description}</p>
            </div>
            {!!recommendation.preview && (
              <div className={styles.recommendationPreview}>
                <div className={styles.recommendationPreviewCanvas}>{recommendation.preview}</div>
              </div>
            )}
            <CodeSnippet code={recommendation.code} />
          </article>
        )}
      />
    </div>
  )
})

ComponentRecommendationList.displayName = 'ComponentRecommendationList'
