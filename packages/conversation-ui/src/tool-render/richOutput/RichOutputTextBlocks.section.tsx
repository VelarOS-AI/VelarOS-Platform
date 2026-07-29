import React from 'react'

import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'

import styles from './RichOutputToolRender.module.css'

export function RichOutputAnswerText({
  children,
}: {
  children: React.ReactNode
}): React.ReactElement {
  return (
    <Paragraph spacing="none" className={styles.answer}>
      {children}
    </Paragraph>
  )
}

export function RichOutputMutedText({
  children,
}: {
  children: React.ReactNode
}): React.ReactElement {
  return (
    <Paragraph spacing="none" className={styles.emptyState}>
      {children}
    </Paragraph>
  )
}

export function RichOutputItemDetailText({
  children,
}: {
  children: React.ReactNode
}): React.ReactElement {
  return (
    <Paragraph spacing="none" className={styles.itemDescription}>
      {children}
    </Paragraph>
  )
}
