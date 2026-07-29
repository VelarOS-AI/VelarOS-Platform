import {
  ArchiveIcon,
  ArrowCounterClockwiseIcon,
  ArrowsClockwiseIcon,
  BinocularsIcon,
  BookOpenTextIcon,
  BookOpenUserIcon,
  BrainIcon,
  BrowserIcon,
  CrosshairSimpleIcon,
  FileDocIcon,
  FileTextIcon,
  FoldersIcon,
  GaugeIcon,
  GitBranchIcon,
  GitDiffIcon,
  GlobeIcon,
  InfoIcon,
  LayoutIcon,
  ListBulletsIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  MapTrifoldIcon,
  NotePencilIcon,
  PackageIcon,
  PathIcon,
  PlugsConnectedIcon,
  PlugsIcon,
  RobotIcon,
  SealQuestionIcon,
  SelectionPlusIcon,
  ShieldCheckIcon,
  TargetIcon,
  TerminalWindowIcon,
  TrayArrowUpIcon,
  UserFocusIcon,
  WrenchIcon,
} from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import { inferToolLeadingKind, type ToolLeadingKind } from './inferToolLeadingKind'

function iconSize(size: number): number {
  return size
}

export function toolLeadingPhosphorIcon(
  kind: ToolLeadingKind,
  size = 12,
  className?: string
): ReactElement {
  const s = iconSize(size)
  const cn = className

  switch (kind) {
    case 'plan':
      return <ListChecksIcon size={s} className={cn} />
    case 'command':
      return <TerminalWindowIcon size={s} weight="regular" className={cn} />
    case 'file-change':
      return <NotePencilIcon size={s} weight="regular" className={cn} />
    case 'edit-diff':
      return <GitDiffIcon size={s} weight="regular" className={cn} />
    case 'edit-rollback':
      return <ArrowCounterClockwiseIcon size={s} weight="regular" className={cn} />
    case 'file-move':
      return <PathIcon size={s} weight="regular" className={cn} />
    case 'refactor':
      return <SelectionPlusIcon size={s} weight="regular" className={cn} />
    case 'search':
      return <MagnifyingGlassIcon size={s} weight="bold" className={cn} />
    case 'list-files':
      return <FoldersIcon size={s} weight="regular" className={cn} />
    case 'browse-remote':
      return <GlobeIcon size={s} className={cn} />
    case 'browser':
      return <BrowserIcon size={s} className={cn} />
    case 'memory':
      return <BrainIcon size={s} weight="regular" className={cn} />
    case 'knowledge':
      return <BookOpenUserIcon size={s} weight="regular" className={cn} />
    case 'git':
      return <GitBranchIcon size={s} weight="regular" className={cn} />
    case 'office-doc':
      return <FileDocIcon size={s} weight="regular" className={cn} />
    case 'artifact':
      return <PackageIcon size={s} weight="regular" className={cn} />
    case 'widget':
      return <LayoutIcon size={s} weight="regular" className={cn} />
    case 'read-local':
      return <FileTextIcon size={s} weight="regular" className={cn} />
    case 'install':
      return <PlugsIcon size={s} weight="regular" className={cn} />
    case 'system-tools':
      return <WrenchIcon size={s} weight="regular" className={cn} />
    case 'tool-catalog':
      return <ListBulletsIcon size={s} weight="regular" className={cn} />
    case 'tool-map':
      return <MapTrifoldIcon size={s} weight="regular" className={cn} />
    case 'tool-read':
      return <BookOpenTextIcon size={s} weight="regular" className={cn} />
    case 'tool-replace':
      return <TrayArrowUpIcon size={s} weight="regular" className={cn} />
    case 'tool-reflect':
      return <PlugsConnectedIcon size={s} weight="regular" className={cn} />
    case 'goal':
      return <TargetIcon size={s} weight="regular" className={cn} />
    case 'active-directive':
      return <ShieldCheckIcon size={s} weight="regular" className={cn} />
    case 'archive':
      return <ArchiveIcon size={s} weight="regular" className={cn} />
    case 'user-confirmation':
      return <SealQuestionIcon size={s} weight="regular" className={cn} />
    case 'user-action':
      return <UserFocusIcon size={s} weight="regular" className={cn} />
    case 'agent-dispatch':
      return <RobotIcon size={s} weight="regular" className={cn} />
    case 'active-project-infer':
      return <CrosshairSimpleIcon size={s} weight="regular" className={cn} />
    case 'dev-environment-summary':
      return <GaugeIcon size={s} weight="regular" className={cn} />
    case 'project-discovery-rescan':
      return <ArrowsClockwiseIcon size={s} weight="regular" className={cn} />
    case 'workspace-roots':
      return <FoldersIcon size={s} weight="regular" className={cn} />
    case 'project-catalog':
      return <BinocularsIcon size={s} weight="regular" className={cn} />
    case 'project-metadata':
      return <InfoIcon size={s} weight="regular" className={cn} />
    case 'generic':
    default:
      return <WrenchIcon size={s} weight="regular" className={cn} />
  }
}

export function toolLeadingPhosphorIconForTool(toolName: string, size?: number, className?: string): ReactElement {
  return toolLeadingPhosphorIcon(inferToolLeadingKind(toolName), size, className)
}
