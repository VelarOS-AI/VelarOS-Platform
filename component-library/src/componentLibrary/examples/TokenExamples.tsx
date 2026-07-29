import { useLayoutEffect, useMemo, useState } from 'react'
import { optionalWhen } from '@catalog/catalogPrimitives'
import { useI18n } from '@catalog/i18n'
import type { CSSProperties, ReactElement } from 'react'

import { Badge } from '@velaros-ai/ui/primitives/display/Badge'
import { Inline } from '@velaros-ai/ui/primitives/layout/Inline'

interface TokenMeta {
  name: string
  role: {
    en: string
    zh: string
  }
  /** 色块列使用变量背景，仅适用于可解析为颜色的令牌。 */
  hasSwatch?: boolean
  /** 很浅的色块使用细边框，例如白色。 */
  lightSwatch?: boolean
}

function readCustomProperties(element: Element, names: readonly string[]): Record<string, string> {
  const computed = getComputedStyle(element)
  const out: Record<string, string> = {}
  for (const name of names) {
    out[name] = computed.getPropertyValue(name).trim()
  }
  return out
}

const uiScaleTokens: readonly TokenMeta[] = [
  {
    name: '--ui-font-title-xl',
    role: { en: 'Hero and startup titles', zh: '开屏与主视觉标题' },
  },
  {
    name: '--ui-font-title-lg',
    role: { en: 'Page and panel titles', zh: '页面和面板标题' },
  },
  {
    name: '--ui-font-heading',
    role: { en: 'Section and card headings', zh: '区块与卡片标题' },
  },
  {
    name: '--ui-font-body-md',
    role: { en: 'Dense panel emphasis', zh: '密集面板强调文字' },
  },
  {
    name: '--ui-font-body',
    role: { en: 'Default app copy', zh: '默认应用正文' },
  },
  {
    name: '--ui-font-body-sm',
    role: { en: 'Table rows and compact UI', zh: '表格行与紧凑界面' },
  },
  {
    name: '--ui-font-caption',
    role: { en: 'Metadata and quiet labels', zh: '元数据和低强调标签' },
  },
  {
    name: '--ui-line-default',
    role: { en: 'Paragraphs and descriptions', zh: '段落与说明' },
  },
  {
    name: '--ui-line-compact',
    role: { en: 'Stacked labels and lists', zh: '堆叠标签与列表' },
  },
  {
    name: '--ui-control-height-sm',
    role: { en: 'Default compact controls', zh: '默认紧凑控件' },
  },
  {
    name: '--ui-control-height-xs',
    role: { en: 'Inline chips and toolbars', zh: '内联芯片与工具条' },
  },
  {
    name: '--ui-radius-panel',
    role: { en: 'Settings cards and dialogs', zh: '设置卡片与对话框' },
  },
  {
    name: '--ui-radius-control',
    role: { en: 'Buttons, fields and inset panels', zh: '按钮、字段与内嵌面板' },
  },
  {
    name: '--ui-space-page',
    role: { en: 'Main window page padding', zh: '主窗口页面边距' },
  },
  {
    name: '--ui-space-control-x',
    role: { en: 'Horizontal padding inside controls', zh: '控件内水平内边距' },
  },
]

const surfaceTokens: readonly TokenMeta[] = [
  {
    name: '--background',
    role: { en: 'Main app base', zh: '主应用底色' },
    hasSwatch: true,
    lightSwatch: true,
  },
  {
    name: '--foreground',
    role: { en: 'Primary text', zh: '主文案' },
    hasSwatch: true,
  },
  {
    name: '--muted-foreground',
    role: { en: 'Secondary and helper text', zh: '次要说明文字' },
    hasSwatch: true,
  },
  {
    name: '--background-panel',
    role: { en: 'Quiet panel surfaces', zh: '低强调面板表面' },
    hasSwatch: true,
  },
  {
    name: '--border',
    role: { en: 'Default separators', zh: '默认分隔线' },
    hasSwatch: true,
  },
  {
    name: '--border-strong',
    role: { en: 'Emphasized outlines', zh: '强调轮廓' },
    hasSwatch: true,
  },
  {
    name: '--status-blue',
    role: { en: 'Active or running', zh: '激活或运行中' },
    hasSwatch: true,
  },
  {
    name: '--status-blue-soft',
    role: { en: 'Info surfaces', zh: '信息提示浅底' },
    hasSwatch: true,
  },
  {
    name: '--status-green',
    role: { en: 'Success', zh: '成功' },
    hasSwatch: true,
  },
  {
    name: '--status-amber',
    role: { en: 'Warning', zh: '警告' },
    hasSwatch: true,
  },
  {
    name: '--status-red',
    role: { en: 'Destructive or failed', zh: '破坏性或失败' },
    hasSwatch: true,
  },
  {
    name: '--shadow-xs',
    role: { en: 'Subtle elevation', zh: '轻微浮起' },
  },
]

function TokenRow({ token, resolved }: { token: TokenMeta; resolved: string }): ReactElement {
  const { locale } = useI18n()
  const display = resolved.length ? resolved : '—'
  const swatchStyle = optionalWhen(token.hasSwatch, (({ '--library-token-swatch': `var(${token.name})` } as CSSProperties)))

  return (
    <div data-library-token-row>
      {token.hasSwatch && (
        <span
          data-library-token-swatch
          data-outline={!!token.lightSwatch}
          style={swatchStyle}
        />
      )}
      <code>{token.name}</code>
      <span>{display}</span>
      <span>{locale === 'zh-CN' ? token.role.zh : token.role.en}</span>
    </div>
  )
}

function TokenMatrix({
  label,
  tokens,
}: {
  label: string
  tokens: readonly TokenMeta[]
}): ReactElement {
  const { t } = useI18n()
  const [resolved, setResolved] = useState<Record<string, string>>({})

  const namesKey = useMemo(() => tokens.map((t) => t.name).join('\0'), [tokens])

  useLayoutEffect(() => {
    setResolved(
      readCustomProperties(
        document.documentElement,
        tokens.map((t) => t.name)
      )
    )
  }, [namesKey, tokens])

  const header = (
    <Inline gap="sm" wrap="wrap">
      <Badge variant="secondary">{label}</Badge>
      <Badge variant="outline">
        {tokens.length}
        {t('componentLibrary.tokenExample.tokensSuffix')}
      </Badge>
    </Inline>
  )

  const list = (
    <div data-library-token-list>
      {tokens.map((token) => (
        <TokenRow key={token.name} token={token} resolved={resolved[token.name] ?? ''} />
      ))}
    </div>
  )

  return (
    <div data-library-token-group>
      {header}
      {list}
    </div>
  )
}

export function UiTokenExamples(): ReactElement {
  const { t } = useI18n()

  return (
    <div data-library-token-sample>
      <TokenMatrix
        label={t('componentLibrary.tokenExample.typeDensityLabel')}
        tokens={uiScaleTokens}
      />
    </div>
  )
}

export function SurfaceTokenExamples(): ReactElement {
  const { t } = useI18n()

  return (
    <div data-library-token-sample>
      <TokenMatrix
        label={t('componentLibrary.tokenExample.surfaceStatusLabel')}
        tokens={surfaceTokens}
      />
    </div>
  )
}
