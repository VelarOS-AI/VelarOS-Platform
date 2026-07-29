import {
  ArrowSquareOutIcon,
  CheckIcon,
  FileTextIcon,
  InfoIcon,
  SparkleIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import { Inline } from '@velaros-ai/ui/primitives/layout/Inline'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'
import { ActionCard } from '@velaros-ai/ui/product/layout/ActionCard'
import {
  CardDisclosure,
  CardFooter,
  CardMeta,
  type CardPillTone,
  CardResultBlock,
  CardStatusPill,
  CardTextButton,
} from '@velaros-ai/ui/product/layout/CardKit'

const ACTION_CARD_TONES: readonly CardPillTone[] = [
  'neutral',
  'info',
  'success',
  'warning',
  'error',
]

const TONE_ICON: Record<CardPillTone, ReactElement> = {
  neutral: <FileTextIcon size={16} />,
  info: <InfoIcon size={16} />,
  success: <CheckIcon size={16} />,
  warning: <WarningIcon size={16} />,
  error: <XIcon size={16} />,
}

/** ActionCard.tone 封闭枚举:row 布局逐 tone 平铺(neutral/info/success/warning/error)。 */
export function ActionCardToneRowExample(): ReactElement {
  return (
    <Stack gap="sm">
      {ACTION_CARD_TONES.map((tone) => (
        <ActionCard
          key={tone}
          tone={tone}
          layout="row"
          icon={TONE_ICON[tone]}
          title={`tone="${tone}" · 单行通知卡`}
          description="row 布局:图标居中、标题溢出省略。"
        />
      ))}
    </Stack>
  )
}

/** ActionCard.layout="stack":富卡形态,标题换行 + 正文纵向堆叠 + footer 动作。 */
export function ActionCardStackExample(): ReactElement {
  return (
    <ActionCard
      tone="info"
      layout="stack"
      icon={<SparkleIcon size={16} />}
      title="stack 布局:图标顶对齐,标题可换行,正文纵向堆叠成富卡"
      description="用于带展开器 / 结论块 / footer 的复合卡片。"
      actions={
        <CardFooter>
          <CardTextButton tone="neutral">稍后</CardTextButton>
          <CardTextButton tone="approve" icon={<CheckIcon size={13} />}>
            采纳
          </CardTextButton>
        </CardFooter>
      }
    >
      <CardResultBlock tone="info">
        结论块可承载执行摘要,tone 走 --action-card-accent 变量,不再各卡硬编码。
      </CardResultBlock>
    </ActionCard>
  )
}

/** ActionCard 失活/可关闭两态:muted(已消费降不透明度) + onDismiss(右上角关闭钮)。 */
export function ActionCardStateExample(): ReactElement {
  return (
    <Stack gap="sm">
      <ActionCard
        tone="neutral"
        icon={<FileTextIcon size={16} />}
        title="muted:已消费 / 失活态整卡降不透明度"
        description="取代各卡自写的 .cardConsumed。"
        muted
      />
      <ActionCard
        tone="warning"
        icon={<WarningIcon size={16} />}
        title="onDismiss:统一右上角关闭按钮"
        description="存在 onDismiss 时渲染关闭钮。"
        onDismiss={() => undefined}
        dismissLabel="关闭"
      />
    </Stack>
  )
}

/** CardStatusPill.tone 封闭枚举(default + mini 两尺寸)。 */
export function CardStatusPillExample(): ReactElement {
  return (
    <Stack gap="sm">
      <Inline gap="sm" wrap="wrap">
        {ACTION_CARD_TONES.map((tone) => (
          <CardStatusPill key={tone} tone={tone}>
            {tone}
          </CardStatusPill>
        ))}
      </Inline>
      <Inline gap="sm" wrap="wrap">
        {ACTION_CARD_TONES.map((tone) => (
          <CardStatusPill key={tone} tone={tone} size="mini">
            mini · {tone}
          </CardStatusPill>
        ))}
      </Inline>
    </Stack>
  )
}

/** CardResultBlock.tone 封闭枚举:整块着色结论 / 摘要文本。 */
export function CardResultBlockExample(): ReactElement {
  return (
    <Stack gap="sm">
      {ACTION_CARD_TONES.map((tone) => (
        <CardResultBlock key={tone} tone={tone}>
          {`tone="${tone}" · 结论 / 错误摘要整块文本`}
        </CardResultBlock>
      ))}
    </Stack>
  )
}

/** CardDisclosure:collapsed(默认收起) 与 open(默认展开) 两态。 */
export function CardDisclosureExample(): ReactElement {
  return (
    <Stack gap="sm">
      <CardDisclosure summary="collapsed:默认收起的展开器">
        <CardResultBlock tone="neutral">展开后的正文内容。</CardResultBlock>
      </CardDisclosure>
      <CardDisclosure summary="open:默认展开" defaultOpen>
        <CardResultBlock tone="neutral">defaultOpen 时首屏即展开。</CardResultBlock>
      </CardDisclosure>
    </Stack>
  )
}

/** CardTextButton.tone 封闭枚举:approve(绿)/reject(红)/neutral(灰),配 CardFooter 对齐。 */
export function CardFooterButtonExample(): ReactElement {
  return (
    <Stack gap="sm">
      <CardFooter align="right">
        <CardTextButton tone="neutral">neutral</CardTextButton>
        <CardTextButton tone="reject" icon={<XIcon size={13} />}>
          reject
        </CardTextButton>
        <CardTextButton tone="approve" icon={<CheckIcon size={13} />}>
          approve
        </CardTextButton>
      </CardFooter>
      <CardFooter align="between">
        <CardMeta icon={<ArrowSquareOutIcon size={13} />}>align="between" 两端对齐</CardMeta>
        <CardTextButton tone="approve">确定</CardTextButton>
      </CardFooter>
    </Stack>
  )
}

/** CardMeta:图标 + 灰度小字的元信息行。 */
export function CardMetaExample(): ReactElement {
  return (
    <Inline gap="md" wrap="wrap">
      <CardMeta icon={<FileTextIcon size={13} />}>涉及 3 个文件</CardMeta>
      <CardMeta icon={<CheckIcon size={13} />}>已验证</CardMeta>
      <CardMeta>纯文本 meta</CardMeta>
    </Inline>
  )
}
