import { type ReactElement, useState } from 'react'

import {
  FileChangeSummaryList,
  type FileChangeSummaryListEntry,
} from '@velaros-ai/conversation-ui'
import { buildFileDiffSummary } from '@velaros-ai/conversation-ui'

const GREETER_BEFORE = `export function greet(name) {
  return 'Hi ' + name
}`

const GREETER_AFTER = `export function greet(name: string): string {
  return \`Hi, \${name}\`
}`

const INDEX_AFTER = `import { greet } from './greeter'

console.log(greet('Velar'))`

const greeterDiff = buildFileDiffSummary(GREETER_BEFORE, GREETER_AFTER)
const indexDiff = buildFileDiffSummary('', INDEX_AFTER)

const ENTRIES: FileChangeSummaryListEntry[] = [
  {
    key: 'greeter',
    path: 'src/greeter.ts',
    added: greeterDiff.added,
    removed: greeterDiff.removed,
    diffSummaries: [greeterDiff],
  },
  {
    key: 'index',
    path: 'src/index.ts',
    added: indexDiff.added,
    removed: indexDiff.removed,
    diffSummaries: [indexDiff],
  },
  {
    key: 'legacy',
    path: 'src/legacy.ts',
    added: 0,
    removed: 4,
    diffSummaries: [buildFileDiffSummary('const legacy = true\nexport default legacy', '')],
    rolledBack: true,
  },
]

/** FileChangeSummaryList:多文件变更行,点击展开显示行级 diff(collapsed / expanded 两态)。 */
export function FileChangeSummaryExample(): ReactElement {
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(new Set(['greeter']))

  function toggleEntry(key: string): void {
    setExpandedKeys((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <FileChangeSummaryList
      entries={ENTRIES}
      expandedKeys={expandedKeys}
      onToggleEntry={toggleEntry}
      onOpenEntry={() => undefined}
    />
  )
}

/** 失活态:disabled(整行不可交互) + actionsDisabled(仅动作禁用)。 */
export function FileChangeSummaryDisabledExample(): ReactElement {
  const entries: FileChangeSummaryListEntry[] = [
    { ...ENTRIES[0], key: 'disabled', disabled: true },
    { ...ENTRIES[1], key: 'actions-disabled', actionsDisabled: true },
  ]

  return (
    <FileChangeSummaryList
      entries={entries}
      expandedKeys={new Set()}
      onToggleEntry={() => undefined}
    />
  )
}
