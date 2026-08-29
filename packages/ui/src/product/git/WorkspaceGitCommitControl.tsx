import {
  type CSSProperties,
  type FormEvent,
  type ReactElement,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  ArrowDownLeftIcon,
  ArrowUpIcon,
  CaretDownIcon,
  CaretRightIcon,
  FolderIcon,
  GitBranchIcon,
  GitCommitIcon,
  PlusIcon,
  SpinnerGapIcon,
} from '@phosphor-icons/react'

// 判定 helper 一律取包内 lib/runtime：UI 包对外承诺运行时零 VelarOS 依赖，
// 从 @velaros-ai/core 取会让外部消费者构建时解析不到（package.json 里本就没这条依赖）。
import { isEmpty, isPresent } from '../../lib/runtime'
import { Button } from '../../primitives/buttons/Button'
import { Input } from '../../primitives/forms/Input'
import { SearchField } from '../../primitives/forms/SearchField'
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
  | 'upload'

export interface WorkspaceGitControlBranch {
  name: string
  current?: boolean
  upstream?: LooseOptional<string>
  kind?: 'local' | 'remote'
}

export interface WorkspaceGitControlStatus {
  branch: string
  upstream?: LooseOptional<string>
  isClean: boolean
  changedFiles: number
}

export interface WorkspaceGitControlSummary {
  repository: boolean
  status?: LooseOptional<WorkspaceGitControlStatus>
  branches: WorkspaceGitControlBranch[]
  lineStats: {
    additions: number
    deletions: number
  }
}

export interface WorkspaceGitCommitControlMessages {
  branchSearchPlaceholder: string
  branchCreate: string
  checkoutAction: string
  commitAction: string
  fetchAction: string
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
  themeColor?: string
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
  onUpload: (branch: WorkspaceGitControlBranch) => void | Promise<void>
  onFetch: () => void | Promise<void>
  onOpenCommit: () => void
  onActionError?: (
    error: unknown,
    action: WorkspaceGitCommitControlAction
  ) => void | Promise<void>
}

type PendingAction = 'create' | 'fetch' | `switch:${string}` | `upload:${string}`

interface BranchTrieNode {
  segment: string
  pathPrefix: string
  branch?: WorkspaceGitControlBranch
  children: Map<string, BranchTrieNode>
}

const BRANCH_LIST_ROW_PADDING_PX = 5
const BRANCH_TREE_INDENT_STEP_PX = 14

function resolveThemeColor(anchor: Nullable<HTMLElement>): Nullable<string> {
  if (!anchor) return null
  const probe = anchor.ownerDocument.createElement('span')
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  probe.style.color = 'var(--workspace-git-theme-color)'
  anchor.append(probe)
  const color = anchor.ownerDocument.defaultView?.getComputedStyle(probe).color.trim() ?? ''
  probe.remove()
  return color || null
}

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
  themeColor,
  variant = 'branch-menu-actions',
  layout = 'pill',
  onMenuOpen,
  onSwitchBranch,
  onCreateBranch,
  onUpload,
  onFetch,
  onOpenCommit,
  onActionError,
}: WorkspaceGitCommitControlProps): Nullable<ReactElement> {
  const [menuOpen, setMenuOpen] = useState(false)
  const [branchSearch, setBranchSearch] = useState('')
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [checkoutCreatedBranch, setCheckoutCreatedBranch] = useState(true)
  const [collapsedBranchGroups, setCollapsedBranchGroups] = useState<Set<string>>(new Set())
  const [pendingAction, setPendingAction] = useState<Nullable<PendingAction>>(null)
  const [resolvedThemeColor, setResolvedThemeColor] = useState<Nullable<string>>(null)
  const themeAnchorRef = useRef<HTMLButtonElement>(null)
  const status = summary.status

  const branches = useMemo(() => {
    if (!isEmpty(summary.branches) || !status?.branch) return summary.branches
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
  const isBusy = isPresent(pendingAction)
  const isDirty = !status.isClean
  const tooltip = isDirty ? messages.changedFiles(status.changedFiles) : messages.clean
  const themeStyle = {
    '--workspace-git-theme-color': themeColor ?? 'var(--primary)',
  } as CSSProperties
  const portalThemeStyle = {
    '--workspace-git-theme-color': resolvedThemeColor ?? 'var(--primary)',
  } as CSSProperties

  function reportActionError(error: unknown, action: WorkspaceGitCommitControlAction): void {
    void onActionError?.(error, action)
  }

  function handleMenuOpenChange(open: boolean): void {
    setMenuOpen(open)
    if (open) {
      setResolvedThemeColor(resolveThemeColor(themeAnchorRef.current))
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
      // @arch-guard:suspend code-style/forbid-redundant-strict-literal-comparison 理由：回调签名是 boolean | void，undefined（宿主没返回值）表示「照常继续」，只有显式 false 才中止；写成 !completed 会把 undefined 一并判成中止，是行为变更而非等价简化。
      if (completed === false) return
      handleMenuOpenChange(false)
      // @arch-guard:suspend code-style/require-error-logging 理由：错误经 reportActionError 交给宿主注入的 onActionError 上报；UI 包对宿主日志零依赖，组件层不自持 Log。
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
      // @arch-guard:suspend code-style/forbid-redundant-strict-literal-comparison 理由：同上，回调是 boolean | void，undefined 表示继续，只有显式 false 才中止。
      if (completed === false) return
      setNewBranchName('')
      setCheckoutCreatedBranch(true)
      setCreateDialogOpen(false)
    } catch (error) {
      // @arch-guard:suspend code-style/require-error-logging 理由：经 reportActionError → 宿主 onActionError 上报；UI 包不自持 Log。
      reportActionError(error, 'create')
    } finally {
      setPendingAction(null)
    }
  }

  async function fetchBranches(): Promise<void> {
    if (disabled || isBusy) return

    try {
      setPendingAction('fetch')
      await onFetch()
    } catch (error) {
      // @arch-guard:suspend code-style/require-error-logging 理由：经 reportActionError → 宿主 onActionError 上报；UI 包不自持 Log。
      reportActionError(error, 'fetch')
    } finally {
      setPendingAction(null)
    }
  }

  async function uploadBranch(branch: WorkspaceGitControlBranch): Promise<void> {
    if (disabled || isBusy || branch.kind === 'remote') return

    try {
      setPendingAction(`upload:${branch.name}`)
      await onUpload(branch)
    } catch (error) {
      // @arch-guard:suspend code-style/require-error-logging 理由：经 reportActionError → 宿主 onActionError 上报；UI 包不自持 Log。
      reportActionError(error, 'upload')
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
      style={themeStyle}
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
        style={portalThemeStyle}
        anchor={({ getAnchorProps }) => (
          <Button
            {...getAnchorProps<HTMLButtonElement>({
              disabled: disabled || isBusy,
              ref: themeAnchorRef,
            })}
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
          <div className={styles.gitCompactSearchSlot}>
            <SearchField
              autoFocus
              size="sm"
              value={branchSearch}
              placeholder={messages.branchSearchPlaceholder}
              onChange={(event) => setBranchSearch(event.target.value)}
            />
          </div>
          <button
            type="button"
            className={styles.gitCompactFetchButton}
            disabled={disabled || isBusy}
            title={messages.fetchAction}
            aria-label={messages.fetchAction}
            onClick={() => void fetchBranches()}
          >
            {pendingAction === 'fetch' ? (
              <SpinnerGapIcon size={14} className={styles.gitCompactSpin} />
            ) : (
              <ArrowDownLeftIcon size={14} />
            )}
          </button>
        </div>

        <div className={styles.gitCompactBranchList}>
          <BranchGroup
            namespace="local"
            label={messages.localBranches}
            branches={localBranches}
            currentBranch={activeBranch}
            pendingAction={pendingAction}
            collapsedGroups={collapsedBranchGroups}
            searching={searchingBranches}
            checkoutAction={messages.checkoutAction}
            uploadAction={messages.uploadAction}
            onToggleGroup={toggleBranchGroup}
            onSelect={(branch) => void switchBranch(branch)}
            onUpload={(branch) => void uploadBranch(branch)}
          />
          <BranchGroup
            namespace="remote"
            label={messages.remoteBranches}
            branches={remoteBranches}
            currentBranch={activeBranch}
            pendingAction={pendingAction}
            collapsedGroups={collapsedBranchGroups}
            searching={searchingBranches}
            checkoutAction={messages.checkoutAction}
            uploadAction={messages.uploadAction}
            onToggleGroup={toggleBranchGroup}
            onSelect={(branch) => void switchBranch(branch)}
            onUpload={(branch) => void uploadBranch(branch)}
          />
        </div>
        {variant === 'branch-menu-actions' && (
          <div className={styles.gitCompactFooter}>
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
        <DialogContent className={styles.gitCreateBranchDialog} style={portalThemeStyle}>
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
                  className={styles.gitCreateBranchSubmit}
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
  checkoutAction,
  uploadAction,
  onToggleGroup,
  onSelect,
  onUpload,
}: {
  namespace: 'local' | 'remote'
  label: string
  branches: WorkspaceGitControlBranch[]
  currentBranch: string
  pendingAction: Nullable<PendingAction>
  collapsedGroups: Set<string>
  searching: boolean
  checkoutAction: string
  uploadAction: string
  onToggleGroup: (pathPrefix: string) => void
  onSelect: (branch: WorkspaceGitControlBranch) => void
  onUpload: (branch: WorkspaceGitControlBranch) => void
}): Nullable<ReactElement> {
  if (isEmpty(branches)) return null

  const branchTrie = buildBranchTrie(branches, namespace)
  const { groupKeys, leafKeys } = partitionRootBranchTrieKeys(branchTrie)

  function renderBranchRow(
    branch: WorkspaceGitControlBranch,
    paddingLeft: number
  ): ReactElement {
    const current = branch.kind !== 'remote' && (branch.current || branch.name === currentBranch)
    const switching = pendingAction === `switch:${branch.name}`
    const rowStyle: CSSProperties = { paddingLeft }
    const uploading = pendingAction === `upload:${branch.name}`

    return (
      <div
        key={`${branch.kind ?? 'local'}:${branch.name}`}
        className={styles.gitCompactBranchRow}
        data-current={current || undefined}
        title={branch.name}
      >
        <button
          type="button"
          className={styles.gitCompactBranchSelect}
          style={rowStyle}
          disabled={isPresent(pendingAction) || current}
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
        <div className={styles.gitCompactBranchHoverActions} role="group">
          <button
            type="button"
            disabled={isPresent(pendingAction) || current}
            title={checkoutAction}
            aria-label={`${checkoutAction} ${branch.name}`}
            onClick={() => onSelect(branch)}
          >
            <GitBranchIcon size={12} />
            <span>{checkoutAction}</span>
          </button>
          {branch.kind !== 'remote' && (
            <button
              type="button"
              disabled={isPresent(pendingAction)}
              title={uploadAction}
              aria-label={`${uploadAction} ${branch.name}`}
              onClick={() => onUpload(branch)}
            >
              {uploading ? (
                <SpinnerGapIcon size={12} className={styles.gitCompactSpin} />
              ) : (
                <ArrowUpIcon size={12} />
              )}
              <span>{uploadAction}</span>
            </button>
          )}
        </div>
      </div>
    )
  }

  function renderTrieNode(node: BranchTrieNode, depth: number): Nullable<ReactElement> {
    const rowPadding = BRANCH_LIST_ROW_PADDING_PX + depth * BRANCH_TREE_INDENT_STEP_PX
    const childKeys = sortedBranchTrieKeys(node.children)
    if (isEmpty(childKeys)) return node.branch ? renderBranchRow(node.branch, rowPadding) : null

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
        <span>{label}</span>
      </div>
      {groupKeys.map((key) => renderTrieNode(branchTrie.get(key)!, 0))}
      {leafKeys.map((key) => renderTrieNode(branchTrie.get(key)!, 0))}
    </section>
  )
}
