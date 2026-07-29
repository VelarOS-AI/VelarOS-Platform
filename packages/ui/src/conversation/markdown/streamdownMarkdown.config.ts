import { cjk } from '@streamdown/cjk'
import { code } from '@streamdown/code'
import { createMathPlugin } from '@streamdown/math'
import type { ControlsConfig, LinkSafetyConfig, PluginConfig } from 'streamdown'

export type StreamdownMarkdownMode = 'static' | 'streaming'

const math = createMathPlugin({
  singleDollarTextMath: true,
})

export const STREAMDOWN_MARKDOWN_PLUGINS = {
  cjk,
  code,
  math,
} satisfies PluginConfig

export const STREAMDOWN_MARKDOWN_CONTROLS = {
  code: {
    copy: true,
    download: true,
  },
  mermaid: false,
  table: {
    copy: true,
    download: true,
    fullscreen: true,
  },
} satisfies ControlsConfig

export const STREAMDOWN_MARKDOWN_LINK_SAFETY = {
  enabled: false,
} satisfies LinkSafetyConfig

export function resolveStreamdownMarkdownMode({
  isStreaming,
}: {
  isStreaming: boolean
}): StreamdownMarkdownMode {
  return isStreaming ? 'streaming' : 'static'
}
