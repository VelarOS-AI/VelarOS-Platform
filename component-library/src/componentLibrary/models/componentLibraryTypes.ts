import type { ReactNode } from 'react'

export type ComponentLibraryLayer = 'UI' | 'Business' | 'Feature' | 'Token' | 'Visual'
export type ComponentLibraryStatus = 'ready' | 'candidate' | 'planned'
export type ComponentLibraryExampleMode = 'fixture' | 'live'

export interface ComponentLibraryExample {
  id: string
  label: string
  node: ReactNode
  code?: string
  /** 实时属性和状态控件，会在文档外壳中作为交互沙箱展示。 */
  interactive?: boolean
}

export interface ComponentLibraryApiRow {
  name: string
  description: string
  type: string
  defaultValue?: string
  recommended?: string
}

export interface ComponentLibraryRecommendation {
  id: string
  title: string
  description: string
  code: string
  /** 与代码片段配对的实时渲染，需要保持同步。 */
  preview?: ReactNode
}

export interface ComponentLibraryEntry {
  id: string
  name: string
  layer: ComponentLibraryLayer
  status: ComponentLibraryStatus
  domain: string
  source: string
  origin?: string
  /** 可选文档正文，从同目录原始文档模块加载。 */
  documentation?: string
  exampleMode?: ComponentLibraryExampleMode
  usage: string
  avoid: string
  /** 业务组件：完整组件示例展示在推荐用法下；基础界面组件展示在通用用法下。 */
  examples: ComponentLibraryExample[]
  /** 通用用法下的可选基础模式，例如业务控件加基础组件。 */
  generalExamples?: ComponentLibraryExample[]
  recommendations?: ComponentLibraryRecommendation[]
  /** 用于生成接口表格的组件名称。 */
  apiComponents?: string[]
  api?: ComponentLibraryApiRow[]
}

export interface ComponentLibrarySection {
  id: string
  title: string
  entries: ComponentLibraryEntry[]
}
