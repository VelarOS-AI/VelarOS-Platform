import { type ReactElement, useState } from 'react'
import { useI18n } from '@catalog/i18n'
import { CheckIcon, TerminalIcon, WrenchIcon } from '@phosphor-icons/react'

import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { Checkbox } from '@velaros-ai/ui/primitives/forms/Checkbox'
import { CollapsibleBlockFrame } from '@velaros-ai/ui/primitives/layout/CollapsibleBlockFrame'
import { Disclosure } from '@velaros-ai/ui/primitives/layout/Disclosure'
import { Inline } from '@velaros-ai/ui/primitives/layout/Inline'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'
import { CompactToolRow } from '@velaros-ai/ui/product/layout/CompactToolRow'
import { ToolDisclosureCard } from '@velaros-ai/ui/product/layout/ToolDisclosureCard'

export function DisclosureExamples(): ReactElement {
  const [frameOpen, setFrameOpen] = useState(true)
  const [catalogToolOn, setCatalogToolOn] = useState(true)
  const { t } = useI18n()

  return (
    <Stack gap="lg" className="min-w-0">
      <Stack gap="xs" className="min-w-0">
        <Text tone="caption">{t('componentLibrary.overlayExample.disclosureCatalogHint')}</Text>
        <Disclosure
          surface="muted"
          defaultOpen
          showDot={false}
          title={t('componentLibrary.overlayExample.disclosureFilesystemTitle')}
          description={t('componentLibrary.overlayExample.disclosureFilesystemDescription')}
          meta="12"
        >
          <Stack gap="xs" className="py-2">
            <Inline className="min-w-0" align="center" justify="between" gap="sm">
              <Text>read_file</Text>
              <Checkbox
                checked={catalogToolOn}
                size="sm"
                aria-label={t('componentLibrary.overlayExample.enableToolAria')}
                onCheckedChange={setCatalogToolOn}
              />
            </Inline>
          </Stack>
        </Disclosure>
      </Stack>

      <Stack gap="xs" className="min-w-0">
        <Text tone="caption">{t('componentLibrary.overlayExample.disclosureCompactHint')}</Text>
        <Disclosure
          tone="success"
          title={t('componentLibrary.overlayExample.planUpdatedTitle')}
          meta="3"
          description={t('componentLibrary.overlayExample.planUpdatedDescription')}
          defaultOpen
        >
          <CompactToolRow
            icon={<CheckIcon size={14} />}
            label={t('componentLibrary.overlayExample.compactRowLabel')}
            detail={t('componentLibrary.overlayExample.compactRowDetail')}
            tone="success"
          />
        </Disclosure>
      </Stack>

      <Stack gap="xs" className="min-w-0">
        <Text tone="caption">{t('componentLibrary.overlayExample.toolCardHint')}</Text>
        <ToolDisclosureCard
          title={t('componentLibrary.overlayExample.toolCallTitle')}
          subtitle={t('componentLibrary.overlayExample.toolCallSubtitle')}
          statusTone="running"
          statusIcon={
            <span
              aria-hidden
              className="inline-block size-2 rounded-full bg-[var(--status-blue)]"
            />
          }
          leadingIcon={<WrenchIcon size={14} />}
          meta="12s"
          defaultOpen
        >
          <CompactToolRow
            icon={<TerminalIcon size={14} />}
            label="tsc --noEmit"
            detail={t('componentLibrary.overlayExample.runningDetail')}
            tone="running"
          />
        </ToolDisclosureCard>
      </Stack>

      <Stack gap="xs" className="min-w-0">
        <Text tone="caption">{t('componentLibrary.overlayExample.collapsibleHint')}</Text>
        <CollapsibleBlockFrame
          open={frameOpen}
          title={t('componentLibrary.overlayExample.debugSectionTitle')}
          meta="trace"
          expandLabel={t('componentLibrary.overlayExample.expandDebug')}
          collapseLabel={t('componentLibrary.overlayExample.collapseDebug')}
          onOpenChange={setFrameOpen}
        >
          <Text tone="secondary">{t('componentLibrary.overlayExample.debugBody')}</Text>
        </CollapsibleBlockFrame>
      </Stack>
    </Stack>
  )
}

export const disclosureRecommendations = [
  {
    id: 'tool-catalog-category',
    title: 'Tool catalog categories',
    description:
      'ToolCatalogPanel stacks Disclosure with surface="muted", meta counts, and tool rows with trailing Checkbox.',
    preview: (
      <Disclosure
        surface="muted"
        defaultOpen
        showDot={false}
        title="Filesystem"
        description="Scoped tools"
        meta="8"
      >
        <Stack className="py-2">
          <Text tone="caption" className="text-muted-foreground">
            read_file · list_dir …
          </Text>
        </Stack>
      </Disclosure>
    ),
    code: `// components/business/tool/ToolCatalogPanel.tsx
<Disclosure
  key={category.id}
  className={styles.categorySection}
  surface="muted"
  defaultOpen={false}
  description={category.description}
  meta={category.meta}
  showDot={false}
  title={category.title}
>
  {category.tools.map((tool) => (
    <div key={tool.id} className={styles.toolRow}>
      ...
      <Checkbox checked={tool.enabled} size="sm" onCheckedChange={tool.onEnabledChange} />
    </div>
  ))}
</Disclosure>`,
  },
  {
    id: 'tool-call-card',
    title: 'Chat tool disclosure',
    description:
      'ToolCallBlock renders ToolDisclosureCard with status tone/icon, wrench leading icon, args/result stacks, or CompactToolRow when compact.',
    preview: (
      <div className="max-w-[360px]">
        <ToolDisclosureCard
          title="memory_search"
          subtitle="Query workspace knowledge"
          statusTone="success"
          statusIcon={<CheckIcon size={13} />}
          leadingIcon={<WrenchIcon size={12} />}
          defaultOpen={false}
        >
          <Text tone="caption" className="text-muted-foreground">
            Args / result …
          </Text>
        </ToolDisclosureCard>
      </div>
    ),
    code: `// components/debug/toolRenders/ToolCallBlock.tsx
<ToolDisclosureCard
  statusTone={tone}
  statusIcon={...}
  leadingIcon={<WrenchIcon size={12} className={styles.toolIcon} />}
  title={displayName}
  meta={...}
  subtitle={description}
  defaultOpen={false}
>
  <Stack className={styles.sections} gap="sm">...</Stack>
</ToolDisclosureCard>`,
  },
  {
    id: 'widget-debug-frame',
    title: 'Widget debug frame',
    description:
      'WidgetToolRender uses a shell header with a muted background, larger title, and copy/download/reload/source actions.',
    preview: (
      <div className="overflow-hidden rounded-[var(--ui-radius-panel)] border border-border/60 bg-background">
        <div className="flex items-center justify-between gap-2 border-b border-border/50 bg-[var(--background-panel)] px-3 py-2">
          <Text className="truncate text-[var(--ui-font-body-md)] font-semibold">Widget</Text>
          <Text tone="caption">copy / download / reload / source</Text>
        </div>
        <div className="p-3">
          <Text tone="caption">HtmlPreviewFrame / Streamdown …</Text>
        </div>
      </div>
    ),
    code: `// packages/conversation-ui/src/tool-render/widget/WidgetToolRender.tsx
<WidgetToolShell title={title} actions={<HtmlPreviewToolbar ... />}>
  <div className={styles.frameShell}>
    <HtmlPreviewFrame ... />
  </div>
</WidgetToolShell>

// packages/conversation-ui/src/tool-render/widget/WidgetToolShell.tsx
<div className={styles.shell}>
  <header className={styles.header}>
    <div className={styles.title}>{title}</div>
    <div className={styles.actions}>{actions}</div>
  </header>
  <div className={styles.body}>{children}</div>
</div>`,
  },
]
