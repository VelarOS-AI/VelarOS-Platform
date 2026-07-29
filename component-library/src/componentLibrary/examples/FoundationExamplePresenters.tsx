import { useI18n } from '@catalog/i18n'
import type { ReactElement, ReactNode } from 'react'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Inline } from '@velaros-ai/ui/primitives/layout/Inline'

export function TwoButtonDialogFooterPreview(props: {
  primaryLabel: string
  primaryVariant?: 'default' | 'destructive'
}): ReactElement {
  const { primaryLabel, primaryVariant = 'default' } = props
  const { t } = useI18n()

  return (
    <Inline gap="sm" justify="end">
      <Button variant="outline" size="sm">
        {t('common.cancel')}
      </Button>
      {primaryVariant === 'destructive' ? (
        <Button variant="destructive" size="sm">
          {primaryLabel}
        </Button>
      ) : (
        <Button size="sm">{primaryLabel}</Button>
      )}
    </Inline>
  )
}

export function GhostIconSmPreview(props: { label: string; children: ReactNode }): ReactElement {
  return (
    <IconButton label={props.label} variant="ghost" size="icon-sm">
      {props.children}
    </IconButton>
  )
}
