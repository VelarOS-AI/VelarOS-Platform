import { memo, type ReactElement, type ReactNode } from 'react'
import {
  ArrowCounterClockwiseIcon,
  ArrowsClockwiseIcon,
  BinocularsIcon,
  BookOpenIcon,
  BookOpenTextIcon,
  BrainIcon,
  CpuIcon,
  CrosshairIcon,
  FileTextIcon,
  FlowArrowIcon,
  FoldersIcon,
  GaugeIcon,
  GitBranchIcon,
  GitDiffIcon,
  GlobeIcon,
  InfoIcon,
  LaptopIcon,
  ListBulletsIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  MapTrifoldIcon,
  MonitorIcon,
  NotePencilIcon,
  PackageIcon,
  PathIcon,
  PencilSimpleIcon,
  PlugIcon,
  SquaresFourIcon,
  SwapIcon,
  TerminalIcon,
  WrenchIcon,
} from '@phosphor-icons/react'

import { List } from '@velaros-ai/ui/primitives/layout/List'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'
import { CompactToolRow } from '@velaros-ai/ui/product/layout/CompactToolRow'

import type { ToolLeadingKind } from '../tool-render/inferToolLeadingKind'

export type ToolResultSummaryKind = ToolLeadingKind
export type ToolResultSummaryTone = 'neutral' | 'running' | 'success' | 'warning' | 'error'

export interface ToolResultSummaryItem {
  id: string
  kind: ToolResultSummaryKind
  label: ReactNode
  detail?: ReactNode
  detailTitle?: string
  title?: string
  statusLabel?: ReactNode
  statusTitle?: string
  tone?: ToolResultSummaryTone
  action?: ReactNode
  actionLayout?: 'inline' | 'overlay'
}

export interface ToolResultSummaryListProps {
  items: ToolResultSummaryItem[]
  className?: string
  emptyLabel?: ReactNode
  'aria-label'?: string
}

const TOOL_RESULT_ICON_SIZE = 12

function getToolResultIcon(kind: ToolResultSummaryKind): ReactElement {
  const s = TOOL_RESULT_ICON_SIZE
  switch (kind) {
    case 'command':
      return <TerminalIcon size={s} />
    case 'file-change':
      return <NotePencilIcon size={s} />
    case 'edit-diff':
      return <GitDiffIcon size={s} />
    case 'edit-rollback':
      return <ArrowCounterClockwiseIcon size={s} />
    case 'file-move':
      return <PathIcon size={s} />
    case 'refactor':
      return <PencilSimpleIcon size={s} />
    case 'plan':
      return <ListChecksIcon size={s} />
    case 'search':
      return <MagnifyingGlassIcon size={s} />
    case 'browse-remote':
      return <GlobeIcon size={s} />
    case 'browser':
      return <MonitorIcon size={s} />
    case 'memory':
      return <BrainIcon size={s} />
    case 'knowledge':
      return <BookOpenIcon size={s} />
    case 'git':
      return <GitBranchIcon size={s} />
    case 'office-doc':
      return <LaptopIcon size={s} />
    case 'artifact':
      return <PackageIcon size={s} />
    case 'widget':
      return <SquaresFourIcon size={s} />
    case 'read-local':
      return <FileTextIcon size={s} />
    case 'install':
      return <PlugIcon size={s} />
    case 'system-tools':
      return <CpuIcon size={s} />
    case 'tool-catalog':
      return <ListBulletsIcon size={s} />
    case 'tool-map':
      return <MapTrifoldIcon size={s} />
    case 'tool-read':
      return <BookOpenTextIcon size={s} />
    case 'tool-replace':
      return <SwapIcon size={s} />
    case 'tool-reflect':
      return <FlowArrowIcon size={s} />
    case 'active-project-infer':
      return <CrosshairIcon size={s} />
    case 'dev-environment-summary':
      return <GaugeIcon size={s} />
    case 'project-discovery-rescan':
      return <ArrowsClockwiseIcon size={s} />
    case 'workspace-roots':
      return <FoldersIcon size={s} />
    case 'project-catalog':
      return <BinocularsIcon size={s} />
    case 'project-metadata':
      return <InfoIcon size={s} />
    case 'generic':
    default:
      return <WrenchIcon size={s} />
  }
}

function ToolResultSummaryListImpl({
  items,
  className,
  emptyLabel = 'No tool results',
  'aria-label': ariaLabel = 'Tool result summary',
}: ToolResultSummaryListProps): ReactElement {
  return (
    <Stack
      data-business-tool-result-summary-list
      className={className}
      gap="xs"
      role="list"
      aria-label={ariaLabel}
    >
      {items.length ? (
        <List
          items={items}
          keyExtractor={(item) => item.id}
          wrapper="fragment"
          renderItem={(item) => (
            <CompactToolRow
              data-business-tool-result-row
              data-kind={item.kind}
              data-tone={item.tone ?? 'neutral'}
              role="listitem"
              title={item.title}
              tone={item.tone ?? 'neutral'}
              icon={getToolResultIcon(item.kind)}
              label={item.label}
              detail={item.detail}
              detailTitle={item.detailTitle}
              count={item.statusLabel}
              countTitle={item.statusTitle}
              action={item.action}
              actionLayout={item.actionLayout}
            />
          )}
        />
      ) : (
        <CompactToolRow
          data-business-tool-result-empty
          role="listitem"
          tone="neutral"
          icon={getToolResultIcon('generic')}
          label={emptyLabel}
        />
      )}
    </Stack>
  )
}

export const ToolResultSummaryList = memo(ToolResultSummaryListImpl)
ToolResultSummaryList.displayName = 'ToolResultSummaryList'
