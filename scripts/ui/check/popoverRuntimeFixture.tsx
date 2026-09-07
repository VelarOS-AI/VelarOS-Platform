import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AnchoredPopover } from '@velaros-ai/ui/primitives/overlays/AnchoredPopover'
import { WorkspaceGitCommitControl } from '@velaros-ai/ui/product/git/WorkspaceGitCommitControl'

declare global {
  interface Window {
    focusEvents: Array<{ visibility: string; rects: number }>
    preventCloseFocus: boolean
  }
}

const messages = {
  branchSearchPlaceholder: 'Search branches', branchCreate: 'New branch', checkoutAction: 'Checkout',
  commitAction: 'Commit', fetchAction: 'Fetch', uploadAction: 'Push', localBranches: 'Local branches',
  remoteBranches: 'Remote branches', createDialogTitle: 'Create branch', createDialogDescription: () => '',
  createBranchPlaceholder: 'Branch name', checkoutCreatedBranch: 'Checkout new branch', cancel: 'Cancel',
  create: 'Create', clean: 'Clean', changedFiles: () => 'Changed',
}
const summary = {
  repository: true, status: { branch: 'main', upstream: 'origin/main', isClean: true, changedFiles: 0 },
  branches: [
    { name: 'main', kind: 'local' as const, current: true },
    { name: 'feature/search', kind: 'local' as const },
    { name: 'origin/main', kind: 'remote' as const },
  ], lineStats: { additions: 0, deletions: 0 },
}

function FocusProbe(): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [nestedOpen, setNestedOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  return <AnchoredPopover open={open} onOpenChange={setOpen} onOpenAutoFocus={() => {
    const target = input.current!
    window.focusEvents.push({ visibility: getComputedStyle(target).visibility, rects: target.getClientRects().length })
    target.focus()
  }} onCloseAutoFocus={(event) => {
    if (window.preventCloseFocus) event.preventDefault()
  }} anchor={({ getAnchorProps }) => <button {...getAnchorProps()} id="focus-trigger">Focus probe</button>}>
    <input id="focus-target" ref={input} />
    <AnchoredPopover open={nestedOpen} onOpenChange={setNestedOpen}
      anchor={({ getAnchorProps }) => <button {...getAnchorProps()} id="nested-trigger">Nested</button>}>
      <input id="nested-target" />
    </AnchoredPopover>
  </AnchoredPopover>
}

export function mount(): void {
  window.focusEvents = []
  window.preventCloseFocus = false
  createRoot(document.getElementById('root')!).render(<>
    <section id="git"><WorkspaceGitCommitControl summary={summary} messages={messages}
      themeColor="#7c3aed" layout="pill" onSwitchBranch={() => undefined} onCreateBranch={() => undefined}
      onUpload={() => undefined} onFetch={() => undefined} onOpenCommit={() => undefined} /></section>
    <section id="focus"><FocusProbe /></section>
    <input id="outside-focus" aria-label="Outside input" />
  </>)
}
