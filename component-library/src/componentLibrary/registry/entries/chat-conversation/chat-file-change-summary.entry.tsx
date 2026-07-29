import {
  FileChangeSummaryDisabledExample,
  FileChangeSummaryExample,
} from '@catalog/examples/ChatFileChangeExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.chatConversation,
  entryOrder: 40,
  entry: {
    id: 'chat-file-change-summary',
    name: 'File Change Summary List',
    layer: 'Feature',
    status: 'ready',
    domain: 'Chat Conversation',
    source: '@velaros-ai/conversation-ui',
    origin: 'packages/conversation-ui/src/cards',
    exampleMode: 'fixture',
    usage:
      '助手消息尾部的文件变更汇总:多文件行 + 点开显示行级 diff。纯 props 驱动(entries / expandedKeys / onToggleEntry),diff 由 buildFileDiffSummary 生成。',
    avoid:
      '不要把 IPC 差异抓取塞进此展示组件(那是 MessageFileChangeSummary 视图模型的活);此层只吃 view model。',
    examples: [
      { id: 'file-change-list', label: 'FileChangeSummaryList · collapsed/expanded/rolledBack · 手编 fixture', node: <FileChangeSummaryExample /> },
      { id: 'file-change-disabled', label: 'disabled / actionsDisabled 失活态 · 手编 fixture', node: <FileChangeSummaryDisabledExample /> },
    ],
  },
})
