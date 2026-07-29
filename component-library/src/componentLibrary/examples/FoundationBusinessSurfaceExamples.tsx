import { type ReactElement } from 'react'
import { useI18n } from '@catalog/i18n'

import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'
import { BusinessSurface } from '@velaros-ai/ui/product/layout/BusinessSurface'

export function BusinessSurfaceExamples(): ReactElement {
  const { t } = useI18n()

  return (
    <Stack gap="sm">
      <BusinessSurface variant="default" padded>
        {t('componentLibrary.businessSurfaceExample.defaultBody')}
      </BusinessSurface>
      <BusinessSurface variant="code" padded>
        <Text tone="caption" asChild>
          <pre className="m-0 whitespace-pre-wrap font-mono">{`pnpm exec eslint src`}</pre>
        </Text>
      </BusinessSurface>
      <BusinessSurface variant="danger" padded>
        {t('componentLibrary.businessSurfaceExample.dangerBody')}
      </BusinessSurface>
    </Stack>
  )
}

export const businessSurfaceRecommendations = [
  {
    id: 'inspect-detail-pane',
    title: 'Inspect sections',
    description:
      'Compose BusinessSurface variants for summary and code-style blocks instead of bespoke bordered panels inside settings dialogs.',
    code: `// Generic inspection panel
<BusinessSurface variant="default" padded>...</BusinessSurface>
<BusinessSurface variant="code" padded>...</BusinessSurface>`,
  },
]
