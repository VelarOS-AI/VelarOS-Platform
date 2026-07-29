import {
  ActionCardStackExample,
  ActionCardStateExample,
  ActionCardToneRowExample,
  CardDisclosureExample,
  CardFooterButtonExample,
  CardMetaExample,
  CardResultBlockExample,
  CardStatusPillExample,
} from '@catalog/examples/CardKitExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.foundation,
  entryOrder: 45,
  entry: {
    id: 'card-kit',
    name: 'ActionCard / CardKit',
    layer: 'UI',
    status: 'ready',
    domain: 'Interaction cards',
    source: '@velaros-ai/ui/product/layout/ActionCard',
    origin: 'packages/ui/product/layout',
    exampleMode: 'fixture',
    usage:
      '交互卡的零件盒:ActionCard(row/stack 布局 + 五 tone)承壳,CardKit 零件(StatusPill/Meta/Disclosure/Footer/TextButton/ResultBlock)拼装。新卡=纯 JSX 组合,零新 module.css,tone 统一走 --action-card-accent 变量。',
    avoid:
      '不要各卡硬编码 --status-* 颜色或自写 align-items/title-nowrap 覆盖;不要脱离 ActionCard 单独发明卡壳。',
    examples: [
      { id: 'action-card-tone-row', label: 'ActionCard · tone 枚举(row 布局)· 手编', node: <ActionCardToneRowExample /> },
      { id: 'action-card-stack', label: 'ActionCard · layout="stack" 富卡 · 手编', node: <ActionCardStackExample /> },
      { id: 'action-card-state', label: 'ActionCard · muted / onDismiss 两态 · 手编', node: <ActionCardStateExample /> },
      { id: 'card-status-pill', label: 'CardStatusPill · tone 枚举(default/mini)· 手编', node: <CardStatusPillExample /> },
      { id: 'card-result-block', label: 'CardResultBlock · tone 枚举 · 手编', node: <CardResultBlockExample /> },
      { id: 'card-disclosure', label: 'CardDisclosure · collapsed / open · 手编', node: <CardDisclosureExample /> },
      { id: 'card-footer-button', label: 'CardTextButton · approve/reject/neutral + CardFooter · 手编', node: <CardFooterButtonExample /> },
      { id: 'card-meta', label: 'CardMeta · 元信息行 · 手编', node: <CardMetaExample /> },
    ],
    api: [
      {
        name: 'ActionCard.tone',
        description: '封闭枚举,走 --action-card-accent 变量着色。',
        type: "'neutral' | 'info' | 'success' | 'warning' | 'error'",
        defaultValue: "'neutral'",
      },
      {
        name: 'ActionCard.layout',
        description: 'row=图标居中单行卡;stack=图标顶对齐、标题换行、正文纵向堆叠的富卡。',
        type: "'row' | 'stack'",
        defaultValue: "'row'",
      },
      {
        name: 'ActionCard.muted',
        description: '已消费 / 失活态整卡降不透明度。',
        type: 'boolean',
        defaultValue: 'false',
      },
      {
        name: 'ActionCard.onDismiss',
        description: '存在时在右上角渲染统一关闭按钮。',
        type: '() => void',
      },
    ],
  },
})
