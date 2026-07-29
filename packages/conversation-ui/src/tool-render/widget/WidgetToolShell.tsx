import React, { memo, type ReactNode, type Ref } from 'react'

import styles from '../../html-preview/HtmlPreview.module.css'

interface WidgetToolShellProps {
  title: string
  actions?: ReactNode
  children: ReactNode
  rootRef?: Ref<HTMLDivElement>
}

const WidgetToolShell = memo(function WidgetToolShell({
  title,
  actions,
  children,
  rootRef,
}: WidgetToolShellProps): React.ReactElement {
  return (
    <div ref={rootRef} className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.title} title={title}>
          {title}
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </header>
      <div className={styles.body}>{children}</div>
    </div>
  )
})

export { WidgetToolShell }
