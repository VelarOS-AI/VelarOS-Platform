import React, { useMemo, useState } from 'react'

import { useConversationI18n } from '../../i18n'

import { collectProjectSourceViews, projectSourceSegments } from './projectSourceView'

import styles from './ProjectSourceWindows.module.css'

import { Log } from '#internal/runtime'

function SourceSegment({ segment, zh }: { segment: ReturnType<typeof projectSourceSegments>[number]; zh: boolean }) {
  const [limit, setLimit] = useState(200)
  const [copyStatus, setCopyStatus] = useState('')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(segment.text)
      setCopyStatus(zh ? '已复制' : 'Copied')
    } catch (error) {
      Log.tag('project-source-windows').warn('复制源码失败', { error })
      setCopyStatus(zh ? '复制失败' : 'Copy failed')
    }
  }
  return <section>
    <div className={styles.header}>
      <span className={styles.meta}>{segment.fragment ? (zh ? '部分行 · ' : 'Fragment · ') : ''}{segment.label}</span>
      <button type="button" className={styles.button} onClick={() => { void copy() }}>{zh ? '复制源码' : 'Copy source'}</button>
    </div>
    <div className={styles.source}>
      {segment.lines.slice(0, limit).map(([line, text]) => <div className={styles.row} key={line}>
        <span className={styles.gutter} aria-hidden="true">{line}</span><code className={styles.code}>{text}</code>
      </div>)}
    </div>
    {segment.lines.length > limit && <button type="button" className={styles.button} onClick={() => setLimit(limit + 200)}>{zh ? '显示更多行' : 'Show more lines'}</button>}
    {copyStatus && <div className={styles.status} role="status">{copyStatus}</div>}
  </section>
}

export function ProjectSourceWindows({ value }: { value: unknown }) {
  const { locale } = useConversationI18n()
  const zh = locale.toLowerCase().startsWith('zh')
  const windows = useMemo(() => collectProjectSourceViews(value), [value])
  return <div className={styles.windows}>{windows.map((window, index) => <section className={styles.window} key={`${window.path}:${index}`}>
    <div className={styles.header}>{window.path}</div>
    {projectSourceSegments(window).map((segment, i) => <SourceSegment key={`${segment.label}:${i}`} segment={segment} zh={zh} />)}
    {window.hasMore && <div className={styles.status}>{zh ? '当前显示文件片段' : 'Showing a file excerpt'}</div>}
  </section>)}</div>
}

export function ProjectSourceDisclosure({ value }: { value: unknown }) {
  const { locale } = useConversationI18n()
  if (!collectProjectSourceViews(value).length) return null
  return <details className={styles.details}><summary>{locale.toLowerCase().startsWith('zh') ? '查看源码' : 'View source'}</summary><ProjectSourceWindows value={value} /></details>
}
