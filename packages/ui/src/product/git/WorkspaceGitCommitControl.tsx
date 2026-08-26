import {
  type CSSProperties,
  type FormEvent,
  type ReactElement,
  useMemo,
  useState,
} from 'react'
import {
  ArrowDownIcon,
  ArrowDownLeftIcon,
  ArrowUpIcon,
  CaretDownIcon,
  CaretRightIcon,
  FolderIcon,
  GitBranchIcon,
  GitCommitIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  SpinnerGapIcon,
} from '@phosphor-icons/react'

import { Button } from '../../primitives/buttons/Button'
import { Input } from '../../primitives/forms/Input'
import { AnchoredPopover } from '../../primitives/overlays/AnchoredPopover'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../primitives/overlays/Dialog'
import {
  getTopBarControlMainButtonClassName,
  getTopBarControlMainClassName,
  getTopBarControlPanelClassName,
  TopBarControlActionGroup,
  TopBarControlFrame,
} from '../layout/TopBarControlFrame'

import styles from './WorkspaceGitCommitControl.module.css'

export type WorkspaceGitCommitControlVariant = 'branch-menu-actions' | 'inline-actions'
export type WorkspaceGitCommitControlLayout = 'segmented' | 'pill'
export type WorkspaceGitCommitControlAction =
  | 'refresh'
  | 'create'
  | 'fetch'
  | 'switch'
  | 'update'
  | 'upload'

export interface WorkspaceGitControlBranch {
  name: string
  current?: boolean
  upstream?: string | null
  kind?: 'local' | 'remote'
}

export interface WorkspaceGitControlStatus {
  branch: string
  upstream?: string | null
  isClean: boolean
  changedFiles: number
}

export interface WorkspaceGitControlSummary {
  repository: boolean
  status?: WorkspaceGitControlStatus | null
  branches: WorkspaceGitControlBranch[]
  lineStats: {
    additions: number
    deletions: number
  }
}

export interface WorkspaceGitCommitControlMessages {
  branchSearchPlaceholder: string
  branchCreate: string
  commitAction: string
  fetchAction: string
  updateAction: string
  uploadAction: string
  localBranches: string
  remoteBranches: string
  createDialogTitle: string
  createDialogDescription: (branch: string) => string
  createBranchPlaceholder: string
  checkoutCreatedBranch: string
  cancel: string
  create: string
  clean: string
  changedFiles: (count: number) => string
}

export interface WorkspaceGitCommitControlProps {
  summary: WorkspaceGitControlSummary
  messages: WorkspaceGitCommitControlMessages
  disabled?: boolean
  commitDisabled?: boolean
  variant?: WorkspaceGitCommitControlVariant
  layout?: WorkspaceGitCommitControlLayout
  onMenuOpen?: () => void | Promise<void>
  onSwitchBranch: (
    branch: string,
    options?: { create?: boolean; startPoint?: string }
  ) => boolean | void | Promise<boolean | void>
  onCreateBranch: (
    branch: string,
    options: { checkout: boolean }
  ) => boolean | void | Promise<boolean | void>
  onUpdate: () => void | Promise<void>
  onUpload: () => void | Promise<void>
  onFetch: () => void | Promise<void>
  onOpenCommit: () => void
  onActionError?: (
    error: unknown,
    action: WorkspaceGitCommitControlAction
  ) => void | Promise<void>
}

type PendingAction = 'create' | 'fetch' | 'update' | 'upload' | `switch:${string}`

interface BranchTrieNode {
  segment: string
  pathPrefix: string
  branch?: WorkspaceGitControlBranch
  children: Map<string, BranchTrieNode>
}

const BRANCH_LIST_ROW_PADDING_PX = 10
const BRANCH_TREE_INDENT_STEP_PX = 14

function insertBranchTrie(
  root: Map<string, BranchTrieNode>,
  branch: WorkspaceGitControlBranch,
  namespace: 'local' | 'remote'
): void {
  const parts = branch.name.split('/').filter(Boolean)
  let level = root
  let pathAcc = ''

  for (let index = 0; index < parts.length; index++) {
    const segment = parts[index]
    pathAcc = pathAcc ? `${pathAcc}/${segment}` : segment
    let node = level.get(segment)
    if (!node) {
      node = {
        segment,
        pathPrefix: `${namespace}:${pathAcc}`,
        children: new Map(),
      }
      level.set(segment, node)
    }
    if (index === parts.length - 1) node.branch = branch
    level = node.children
  }
}

function buildBranchTrie(
  branches: WorkspaceGitControlBranch[],
  namespace: 'local' | 'remote'
): Map<string, BranchTrieNode> {
  const root = new Map<string, BranchTrieNode>()
  for (const branch of branches) insertBranchTrie(root, branch, namespace)
  return root
}

function sortedBranchTrieKeys(branchTrie: Map<string, BranchTrieNode>): string[] {
  return [...branchTrie.keys()].sort((left, right) => left.localeCompare(right))
}

function partitionRootBranchTrieKeys(branchTrie: Map<string, BranchTrieNode>): {
  groupKeys: string[]
  leafKeys: string[]
} {
  const groupKeys: string[] = []
  const leafKeys: string[] = []
  for (const key of sortedBranchTrieKeys(branchTrie)) {
    const node = branchTrie.get(key)
    if (!node) continue
    if (node.children.size > 0) groupKeys.push(key)
    else if (node.branch) leafKeys.push(key)
  }
  return { groupKeys, leafKeys }
}

function getBranchDisplayName(branchName: string): string {
  const slashIndex = branchName.lastIndexOf('/')
  return slashIndex >= 0 && slashIndex < branchName.length - 1
    ? branchName.slice(slashIndex + 1)
    : branchName
}

function getRemoteLocalBranchName(branchName: string): string {
  const slashIndex = branchName.indexOf('/')
  return slashIndex >= 0 && slashIndex < branchName.length - 1
    ? branchName.slice(slashIndex + 1)
    : branchName
}

/**
 * Shared Git control for Desktop and Workbench hosts.
 *
 * The branch popover and create-branch dialog intentionally live in this component so hosts only
 * provide data and Git action ports. Keyboard commands remain host-owned.
 */
export function WorkspaceGitCommitControl({
  summary,
  messages,
  disabled = false,
  commitDisabled = false,
  variant = 'branch-menu-actions',
  layout = 'pill',
  onMenuOpen,
  onSwitchBranch,
  onCreateBranch,
  onUpdate,
  onUpload,
  onFetch,
  onOpenCommit,
  onActionError,
}: WorkspaceGitCommitControlProps): ReactElement | null {
  const [menuOpen, setMenuOpen] = useState(false)
  const [branchSearch, setBranchSearch] = useState('')
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [checkoutCreatedBranch, setCheckoutCreatedBranch] = useState(true)
  const [collapsedBranchGroups, setCollapsedBranchGroups] = useState<Set<string>>(new Set())
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const status = summary.status

  const branches = useMemo(() => {
    if (summary.branches.length || !status?.branch) return summary.branches
    return [
      {
        name: status.branch,
        current: true,
        upstream: status.upstream,
        kind: 'local' as const,
      },
    ]
  }, [status?.branch, status?.upstream, summary.branches])

  if (!summary.repository || !status?.branch) return null

  const activeBranch = status.branch
  const normalizedSearch = branchSearch.trim().toLocaleLowerCase()
  const filteredBranches = normalizedSearch
    ? branches.filter((branch) => branch.name.toLocaleLowerCase().includes(normalizedSearch))
    : branches
  const localBranches = filteredBranches.filter((branch) => branch.kind !== 'remote')
  const remoteBranches = filteredBranches.filter((branch) => branch.kind === 'remote')
  const searchingBranches = normalizedSearch.length > 0
  const isBusy = pendingAction !== null
  const isDirty = !status.isClean
  const tooltip = isDirty ? messages.changedFiles(status.changedFiles) : messages.clean

  function reportActionError(error: unknown, action: WorkspaceGitCommitControlAction): void {
    void onActionError?.(error, action)
  }

  function handleMenuOpenChange(open: boolean): void {
    setMenuOpen(open)
    if (open) {
      void Promise.resolve(onMenuOpen?.()).catch((error: unknown) => {
        reportActionError(error, 'refresh')
      })
      return
    }
    setBranchSearch('')
  }

  function openCreateBranchDialog(): void {
    handleMenuOpenChange(false)
    setNewBranchName('')
    setCheckoutCreatedBranch(true)
    setCreateDialogOpen(true)
  }

  function handleCreateDialogOpenChange(open: boolean): void {
    if (!open && pendingAction === 'create') return
    setCreateDialogOpen(open)
    if (!open) {
      setNewBranchName('')
      setCheckoutCreatedBranch(true)
    }
  }

  function toggleBranchGroup(pathPrefix: string): void {
    setCollapsedBranchGroups((current) => {
      const next = new Set(current)
      if (next.has(pathPrefix)) next.delete(pathPrefix)
      else next.add(pathPrefix)
      return next
    })
  }

  async function switchBranch(branch: WorkspaceGitControlBranch): Promise<void> {
    const remote = branch.kind === 'remote'
    const targetBranch = remote ? getRemoteLocalBranchName(branch.name) : branch.name
    const current = !remote && (branch.current || branch.name === activeBranch)
    if (disabled || current || isBusy) return

    const localExists = branches.some(
      (candidate) => candidate.kind !== 'remote' && candidate.name === targetBranch
    )

    try {
      setPendingAction(`switch:${branch.name}`)
      const completed = await onSwitchBranch(
        targetBranch,
        remote && !localExists ? { create: true, startPoint: branch.name } : undefined
      )
      if (completed === false) return
      handleMenuOpenChange(false)
    } catch (error) {
      reportActionError(error, 'switch')
    } finally {
      setPendingAction(null)
    }
  }

  async function createBranch(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const branchName = newBranchName.trim()
    if (!branchName || disabled || isBusy) return

    try {
      setPendingAction('create')
      const completed = await onCreateBranch(branchName, { checkout: checkoutCreatedBranch })
      if (completed === false) return
      setNewBranchName('')
      setCheckoutCreatedBranch(true)
      setCreateDialogOpen(false)
    } catch (error) {
      reportActionError(error, 'create')
    } finally {
      setPendingAction(null)
    }
  }

  async function runRemoteAction(action: 'fetch' | 'update' | 'upload'): Promise<void> {
    if (disabled || isBusy) return

    try {
      setPendingAction(action)
      if (action === 'fetch') await onFetch()
      else if (action === 'update') await onUpdate()
      else await onUpload()
    } catch (error) {
      reportActionError(error, action)
    } finally {
      setPendingAction(null)
    }
  }

  function openCommitTool(): void {
    handleMenuOpenChange(false)
    onOpenCommit()
  }

  return (
    <TopBarControlFrame
      busy={isBusy}
      tone={isDirty ? 'default' : 'muted'}
      title={tooltip}
      aria-label={tooltip}
      accent={layout !== 'pill'}
      plain={layout === 'pill'}
      className={styles.gitCompactControl}
    >
      <AnchoredPopover
        open={menuOpen}
        onOpenChange={handleMenuOpenChange}
        anchorClassName={getTopBarControlMainClassName(styles.gitCompactAnchor)}
        className={getTopBarControlPanelClassName(styles.gitCompactMenu)}
        side="bottom"
        align="start"
        sideOffset={6}
        widthStrategy="content"
        anchor={({ getAnchorProps }) => (
          <Button
            {...getAnchorProps<HTMLButtonElement>({ disabled: disabled || isBusy })}
            variant="ghost"
            size="sm"
            className={getTopBarControlMainButtonClassName(styles.gitCompactButton)}
            disabled={disabled || isBusy}
          >
            {pendingAction?.startsWith('switch:') ? (
              <SpinnerGapIcon size={13} className={styles.gitCompactSpin} />
            ) : (
              <GitBranchIcon size={13} weight="bold" />
            )}
            <span className={styles.gitCompactBranch}>{getBranchDisplayName(activeBranch)}</span>
            {isDirty && layout !== 'pill' && (
              <span className={styles.gitCompactStats} aria-label={tooltip}>
                <span data-tone="added">+{summary.lineStats.additions}</span>
                <span data-tone="removed">−{summary.lineStats.deletions}</span>
              </span>
            )}
            <CaretDownIcon size={11} className={styles.gitCompactCaret} />
          </Button>
        )}
      >
        <div className={styles.gitCompactMenuHeader}>
          <div className={styles.gitCompactSearchField}>
            <MagnifyingGlassIcon size={14} className={styles.gitCompactSearchIcon} />
            <Input
              autoFocus
              variant="ghost"
              size="sm"
              className={styles.gitCompactInput}
              value={branchSearch}
              placeholder={messages.branchSearchPlaceholder}
              onChange={(event) => setBranchSearch(event.target.value)}
            />
            <button
              type="button"
              className={styles.gitCompactCreateToggle}
              disabled={disabled || isBusy}
              title={messages.fetchAction}
              aria-label={messages.fetchAction}
              onClick={() => void runRemoteAction('fetch')}
            >
              {pendingAction === 'fetch' ? (
                <SpinnerGapIcon size={14} className={styles.gitCompactSpin} />
              ) : (
                <ArrowDownLeftIcon size={14} />
              )}
            </button>
          </div>
        </div>

        {variant === 'branch-menu-actions' && (
          <div className={styles.gitCompactActions}>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled || isBusy}
              onClick={() => void runRemoteAction('update')}
            >
              {pendingAction === 'update' ? (
                <SpinnerGapIcon size={14} className={styles.gitCompactSpin} />
              ) : (
                <ArrowDownIcon size={14} />
              )}
              {messages.updateAction}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled || commitDisabled || isBusy}
              onClick={openCommitTool}
            >
              <GitCommitIcon size={14} />
              {messages.commitAction}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled || isBusy}
              onClick={() => void runRemoteAction('upload')}
            >
              {pendingAction === 'upload' ? (
                <SpinnerGapIcon size={14} className={styles.gitCompactSpin} />
              ) : (
                <ArrowUpIcon size={14} />
              )}
              {messages.uploadAction}
            </Button>
            <div className={styles.gitCompactActionDivider} />
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled || isBusy}
              onClick={openCreateBranchDialog}
            >
              <PlusIcon size={14} />
              {messages.branchCreate}
            </Button>
          </div>
        )}

        <div className={styles.gitCompactBranchList}>
          <BranchGroup
            namespace="local"
            label={messages.localBranches}
            branches={localBranches}
            currentBranch={activeBranch}
            pendingAction={pendingAction}
            collapsedGroups={collapsedBranchGroups}
            searching={searchingBranches}
            onToggleGroup={toggleBranchGroup}
            onSelect={(branch) => void switchBranch(branch)}
          />
          <BranchGroup
            namespace="remote"
            label={messages.remoteBranches}
            branches={remoteBranches}
            currentBranch={activeBranch}
            pendingAction={pendingAction}
            collapsedGroups={collapsedBranchGroups}
            searching={searchingBranches}
            onToggleGroup={toggleBranchGroup}
            onSelect={(branch) => void switchBranch(branch)}
          />
        </div>
      </AnchoredPopover>

      {variant === 'inline-actions' && (
        <TopBarControlActionGroup className={styles.gitCompactInlineActions}>
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || !isDirty || commitDisabled || isBusy}
            onClick={openCommitTool}
          >
            <GitCommitIcon size={14} />
            {messages.commitAction}
          </Button>
        </TopBarControlActionGroup>
      )}

      <Dialog open={createDialogOpen} onOpenChange={handleCreateDialogOpenChange}>
        <DialogContent className={styles.gitCreateBranchDialog}>
          <DialogHeader>
            <DialogTitle>{messages.createDialogTitle}</DialogTitle>
            <DialogDescription>
              {messages.createDialogDescription(activeBranch)}
            </DialogDescription>
          </DialogHeader>
          <form className={styles.gitCreateBranchDialogForm} onSubmit={createBranch}>
            <Input
              autoFocus
              size="sm"
              className={styles.gitCreateBranchInput}
              value={newBranchName}
              disabled={disabled || isBusy}
              placeholder={messages.createBranchPlaceholder}
              onChange={(event) => setNewBranchName(event.target.value)}
            />
            <DialogFooter className={styles.gitCreateBranchDialogFooter}>
              <label className={styles.gitCreateBranchCheckout}>
                <input
                  className={styles.gitCreateBranchCheckoutInput}
                  type="checkbox"
                  checked={checkoutCreatedBranch}
                  disabled={disabled || isBusy}
                  onChange={(event) => setCheckoutCreatedBranch(event.target.checked)}
                />
                <span>{messages.checkoutCreatedBranch}</span>
              </label>
              <div className={styles.gitCreateBranchDialogActions}>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={isBusy}
                  onClick={() => handleCreateDialogOpenChange(false)}
                >
                  {messages.cancel}
                </Button>
                <Button
                  size="sm"
                  disabled={!newBranchName.trim() || disabled || isBusy}
                  type="submit"
                >
                  {pendingAction === 'create' ? (
                    <SpinnerGapIcon size={13} className={styles.gitCompactSpin} />
                  ) : (
                    messages.create
                  )}
                </Button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </TopBarControlFrame>
  )
}

function BranchGroup({
  namespace,
  label,
  branches,
  currentBranch,
  pendingAction,
  collapsedGroups,
  searching,
  onToggleGroup,
  onSelect,
}: {
  namespace: 'local' | 'remote'
  label: string
  branches: WorkspaceGitControlBranch[]
  currentBranch: string
  pendingAction: PendingAction | null
  collapsedGroups: Set<string>
  searching: boolean
  onToggleGroup: (pathPrefix: string) => void
  onSelect: (branch: WorkspaceGitControlBranch) => void
}): ReactElement | null {
  if (!branches.length) return null

  const branchTrie = buildBranchTrie(branches, namespace)
  const { groupKeys, leafKeys } = partitionRootBranchTrieKeys(branchTrie)

  function renderBranchRow(
    branch: WorkspaceGitControlBranch,
    paddingLeft: number
  ): ReactElement {
    const current = branch.kind !== 'remote' && (branch.current || branch.name === currentBranch)
    const switching = pendingAction === `switch:${branch.name}`
    const rowStyle: CSSProperties = { paddingLeft }

    return (
      <button
        key={`${branch.kind ?? 'local'}:${branch.name}`}
        type="button"
        className={styles.gitCompactBranchRow}
        style={rowStyle}
        data-current={current || undefined}
        disabled={pendingAction !== null}
        title={branch.name}
        onClick={() => onSelect(branch)}
      >
        {switching ? (
          <SpinnerGapIcon size={13} className={styles.gitCompactSpin} />
        ) : (
          <GitBranchIcon size={13} weight={current ? 'fill' : 'regular'} />
        )}
        <span>{getBranchDisplayName(branch.name)}</span>
        {current && branch.upstream && <small>{branch.upstream}</small>}
        <CaretRightIcon size={11} className={styles.gitCompactBranchChevron} />
      </button>
    )
  }

  function renderTrieNode(node: BranchTrieNode, depth: number): ReactElement | null {
    const rowPadding = BRANCH_LIST_ROW_PADDING_PX + depth * BRANCH_TREE_INDENT_STEP_PX
    const childKeys = sortedBranchTrieKeys(node.children)
    if (!childKeys.length) return node.branch ? renderBranchRow(node.branch, rowPadding) : null

    const expanded = searching || !collapsedGroups.has(node.pathPrefix)
    return (
      <div key={node.pathPrefix} className={styles.gitCompactBranchTreeGroup}>
        <button
          type="button"
          className={styles.gitCompactBranchTreeHeader}
          style={{ paddingLeft: rowPadding }}
          aria-expanded={expanded}
          onClick={() => onToggleGroup(node.pathPrefix)}
        >
          <CaretDownIcon
            size={11}
            className={styles.gitCompactBranchTreeCaret}
            data-collapsed={!expanded || undefined}
          />
          <FolderIcon size={14} className={styles.gitCompactBranchTreeFolder} />
          <span>{node.segment}</span>
        </button>
        {expanded && (
          <div className={styles.gitCompactBranchTreeNest}>
            {node.branch && renderBranchRow(node.branch, rowPadding + BRANCH_TREE_INDENT_STEP_PX)}
            {childKeys.map((key) => renderTrieNode(node.children.get(key)!, depth + 1))}
          </div>
        )}
      </div>
    )
  }

  return (
    <section className={styles.gitCompactBranchGroup} aria-label={label}>
      <div className={styles.gitCompactBranchSectionHeader}>
        <CaretDownIcon size={11} />
        <span>{label}</span>
      </div>
      {groupKeys.map((key) => renderTrieNode(branchTrie.get(key)!, 0))}
      {leafKeys.map((key) => renderTrieNode(branchTrie.get(key)!, 0))}
    </section>
  )
}
