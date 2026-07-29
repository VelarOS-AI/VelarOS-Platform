import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.foundation,
  entryOrder: 42,
  entry: {
    id: 'marquee-text',
    name: 'Marquee Text',
    layer: 'UI',
    status: 'ready',
    domain: 'Main window',
    source: '@velaros-ai/ui',
    origin: 'packages/ui/src/primitives/display/MarqueeText',
    usage:
      '溢出自动横向滚动的单行文本（跑马灯）：不溢出时静态省略号，溢出且 active 时循环滚动；字色 / 字号从父级继承。',
    avoid:
      '不要向内注入 className / style（封闭形态无逃生口）；单点外观走消费方本地包裹元素 + 继承，或对稳定类名 :global 覆盖。',
    examples: [],
    apiComponents: ['MarqueeText'],
  },
})
