import { useMemo } from 'react'

import { tokenizeHtmlArtifactSource } from './htmlArtifactCodeTokenizer'

import styles from '../html-preview/HtmlPreview.module.css'

function HtmlArtifactSourceCode({ source }: { source: string }): React.ReactElement {
  const codeTokens = useMemo(() => tokenizeHtmlArtifactSource(source), [source])

  return (
    <pre className={styles.codeSource}>
      <code className={styles.codeSourceCode}>
        {codeTokens.map((token, index) => (
          <span key={`${index}:${token.kind}`} className={styles[`codeToken${token.kind}`]}>
            {token.value}
          </span>
        ))}
      </code>
    </pre>
  )
}

export { HtmlArtifactSourceCode }
