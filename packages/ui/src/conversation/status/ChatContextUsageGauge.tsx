import { type CSSProperties, type ReactElement } from 'react'
import { GaugeIcon } from '@phosphor-icons/react'

import { StyleUtils } from '@velaros-ai/ui'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { BubbleTooltip } from '@velaros-ai/ui/primitives/overlays/Tooltip'

import styles from './ChatContextUsageGauge.module.css'

import { isNull } from '#internal/runtime'

const cx = StyleUtils.bindCx(styles)

/** 环的可读性下限：20px 圆环上 3% 弧长约 2px，再小「有一点」和「没有」就画成同一个样子。 */
const MinimumVisibleRingPercent = 3

/**
 * 色阶的两条阈值。
 *
 * 权威在 Agent 侧（`ContextUsageHighWatermarkPercent` / `ContextUsageCompactionPercent`，
 * 送核门与压缩触发同源）。UI 包不许依赖 agent 包，因此这里是一份**镜像**——改那边记得改这里，
 * 否则仪表变红的时刻会和真正开始压缩的时刻慢慢错开。放在共享组件里而不是各产品各写一份，
 * 是为了让这份镜像只有一处。
 */
const ContextUsageWarningPercent = 90
const ContextUsageDangerPercent = 100

export type ChatContextUsageTone = 'safe' | 'warning' | 'danger'
export type ChatContextUsageGaugeVariant = 'badge' | 'icon'

export interface ChatContextUsageGaugeProps {
  /** `icon` 只留圆环，`badge` 额外显示百分比文字。 */
  variant?: ChatContextUsageGaugeVariant
  tone: ChatContextUsageTone
  /**
   * 环的弧长百分比（0–100）。
   *
   * `null` = 拿不到可信弧长（例如媒体 token 未知），环画空但控件仍在——把「算不准」画成
   * 「占用为零」是两回事，后者会让人以为还有满格余量。
   */
  ringPercent: Nullable<number>
  /** 徽标上的百分比文字；`icon` 档不渲染，但仍进 aria。 */
  label: string
  ariaLabel: string
  tooltip: {
    title: string
    meta: string
  }
}

/**
 * 上下文用量仪表（纯展示）。
 *
 * 「用了多少上下文」的**算法**是宿主的事（各产品的会话形状、模型窗口与治理口径不同），
 * 本组件只负责那一圈环、色阶与 tooltip 的像素，让两端长得一模一样。宿主把算好的
 * tone / 弧长 / 三段文案传进来即可——包内不引 `@velaros-ai/agent`，UI 包的独立性由此保持。
 */
export function ChatContextUsageGauge({
  variant = 'badge',
  tone,
  ringPercent,
  label,
  ariaLabel,
  tooltip,
}: ChatContextUsageGaugeProps): ReactElement {
  const isIconOnly = variant === 'icon'
  const progressStyle = {
    '--usage-progress': formatChatContextUsageRingProgress(ringPercent),
  } as CSSProperties

  return (
    <BubbleTooltip
      side="bottom"
      align="start"
      sideOffset={10}
      ariaLabel={ariaLabel}
      contentClassName={styles.tooltipBubble}
      arrowClassName={styles.tooltipArrow}
      arrowWidth={14}
      arrowHeight={10}
      content={
        <div className={styles.tooltipContent}>
          <Text className={styles.tooltipTitle}>{tooltip.title}</Text>
          <Text className={styles.tooltipMeta}>{tooltip.meta}</Text>
        </div>
      }
    >
      <span
        role="img"
        className={cx(
          'root',
          `tone${tone[0]!.toUpperCase()}${tone.slice(1)}`,
          isIconOnly && 'iconOnly'
        )}
        aria-label={ariaLabel}
        tabIndex={0}
        style={progressStyle}
      >
        <span className={styles.iconOrb} aria-hidden="true">
          <span className={styles.iconRing} />
          <span className={styles.iconCore}>
            <GaugeIcon size={12} weight="bold" />
          </span>
        </span>
        {!isIconOnly && <Text className={styles.percent}>{label}</Text>}
      </span>
    </BubbleTooltip>
  )
}

/** 弧长字符串；`null`（算不准）与 0 都画空环，正数落在可读性下限之上。 */
export function formatChatContextUsageRingProgress(percent: Nullable<number>): string {
  if (isNull(percent) || !Number.isFinite(percent)) return '0%'
  const clamped = Math.min(100, Math.max(0, percent))
  const visible = clamped > 0 && clamped < MinimumVisibleRingPercent
    ? MinimumVisibleRingPercent
    : clamped
  return `${visible}%`
}

/** 余量色阶；颜色只表示还剩多少，压缩决策由运行时自动完成。 */
export function resolveChatContextUsageTone(percent: number): ChatContextUsageTone {
  if (percent > ContextUsageDangerPercent) return 'danger'
  if (percent >= ContextUsageWarningPercent) return 'warning'
  return 'safe'
}

/**
 * 百分比文字。
 *
 * 徽标与 tooltip 共用同一串：同一个数在同一个控件上出现两种写法（`<1%` vs `0.4%`）是
 * 上一版实打实踩过的坑。
 */
export function formatChatContextUsagePercent(percent: number): string {
  if (percent > 0 && percent < 0.1) return '<0.1%'
  if (percent >= 10) return `${Math.round(percent)}%`
  return `${percent.toFixed(1)}%`
}
