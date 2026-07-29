import { memo, type ReactElement, useMemo } from 'react'
import { Streamdown } from 'streamdown'

import {
  buildStreamdownCodeFence,
  resolveStreamdownMarkdownMode,
  STREAMDOWN_MARKDOWN_CONTROLS,
  STREAMDOWN_MARKDOWN_LINK_SAFETY,
  STREAMDOWN_MARKDOWN_PLUGINS,
} from '@velaros-ai/ui/conversation/markdown'

import styles from '@catalog/styles/ComponentLibraryPage.module.css'

interface CodeSnippetProps {
  code: string
  language?: string
  showLineNumbers?: boolean
}

/** 文档用语法高亮块：令牌颜色来自样式对象，外壳来自样式模块。 */
export const CodeSnippet = memo(function CodeSnippet({
  code,
  language = 'tsx',
}: CodeSnippetProps): ReactElement {
  const markdown = useMemo(
    () => buildStreamdownCodeFence({ code: code.trim(), language }),
    [code, language]
  )

  return (
    <Streamdown
      key={markdown}
      mode={resolveStreamdownMarkdownMode({ isStreaming: false })}
      plugins={STREAMDOWN_MARKDOWN_PLUGINS}
      controls={STREAMDOWN_MARKDOWN_CONTROLS}
      linkSafety={STREAMDOWN_MARKDOWN_LINK_SAFETY}
      className={`${styles.codeBlock} ${styles.codeStreamdown}`}
    >
      {markdown}
    </Streamdown>
  )
})

CodeSnippet.displayName = 'CodeSnippet'
