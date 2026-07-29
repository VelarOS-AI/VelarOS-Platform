import { useI18n } from '@catalog/i18n'
import type { ReactElement } from 'react'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Badge } from '@velaros-ai/ui/primitives/display/Badge'
import { Inline } from '@velaros-ai/ui/primitives/layout/Inline'
import { Panel } from '@velaros-ai/ui/primitives/layout/Panel'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'

export function MainWindowDomainExamples(): ReactElement {
  const { t } = useI18n()

  return (
    <Panel variant="muted">
      <Stack gap="sm">
        <Inline gap="sm" wrap="wrap">
          <Badge variant="secondary">{t('componentLibrary.visualExample.badgeMainWindow')}</Badge>
          <Badge variant="outline">--ui-*</Badge>
        </Inline>
        <Inline gap="sm" wrap="wrap">
          <Button size="sm" variant="outline">
            {t('componentLibrary.visualExample.review')}
          </Button>
          <Button size="sm">{t('componentLibrary.visualExample.apply')}</Button>
        </Inline>
      </Stack>
    </Panel>
  )
}

export function EditorDomainExamples(): ReactElement {
  const { t } = useI18n()

  return (
    <div data-library-editor-sample>
      <div data-library-editor-toolbar>
        <span>main.tsx</span>
        <span>{t('componentLibrary.visualExample.gitFiles')}</span>
      </div>
      <div data-library-editor-body>
        <span>src/renderer</span>
        <strong>ComponentLibraryPage.tsx</strong>
        <span>styles/features/componentLibrary/ComponentLibraryPage.module.css</span>
      </div>
    </div>
  )
}
