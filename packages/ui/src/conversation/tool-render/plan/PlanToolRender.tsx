import React, { memo } from 'react'
import {
  CheckCircleIcon,
  CircleIcon,
  ListChecksIcon,
  WarningCircleIcon,
  XCircleIcon,
} from '@phosphor-icons/react'

import { StyleUtils } from '@velaros-ai/ui'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { ToolDisclosureCard } from '@velaros-ai/ui/product/layout/ToolDisclosureCard'

import { useConversationI18n, useConversationTranslatorRuntime } from '../../i18n'
import { normalizeInline } from '../toolCallSummary'
import { getToolDisplayName } from '../toolPresentation'

import {
  arePlanToolStepsCompleted,
  getPlanToolBlockExplanation,
  getPlanToolBlockSteps,
  hasFailedPlanToolStep,
  type PlanToolStepPreview,
} from './planToolBlock'

import styles from './PlanToolRender.module.css'

import type { ToolCallBlock } from '#contracts'
import { isEmpty, optionalWhenLazy,toNullable } from '#internal/runtime'

type PlanToolTone = 'running' | 'success' | 'error'
type PlanStepTone = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
type PlanToolRenderVariant = 'card' | 'plain'

type PlanStepPreview = PlanToolStepPreview

const cx = StyleUtils.bindCx(styles)

function getToolTone(block: ToolCallBlock, steps: readonly PlanToolStepPreview[]): PlanToolTone {
  if (block.error) return 'error'
  if (hasFailedPlanToolStep(steps)) return 'error'

  return arePlanToolStepsCompleted(steps) ? 'success' : 'running'
}

function getStepTone(status: string): PlanStepTone {
  switch (status) {
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'skipped':
      return 'skipped'
    case 'delegated':
    case 'running':
    case 'in_progress':
      return 'running'
    case 'pending':
    default:
      return 'pending'
  }
}

function getStatusLabel(status: string, t: ReturnType<typeof useConversationI18n>['t']): string {
  switch (status) {
    case 'completed':
      return t('debug.planStatusLabels.completed')
    case 'failed':
      return t('debug.planStatusLabels.failed')
    case 'skipped':
      return t('debug.planStatusLabels.skipped')
    case 'delegated':
      return t('debug.planStatusLabels.delegated')
    case 'running':
    case 'in_progress':
      return t('debug.planStatusLabels.running')
    case 'pending':
      return t('debug.planStatusLabels.pending')
    default:
      return status
  }
}

function getStepIcon(tone: PlanStepTone): React.ReactElement {
  switch (tone) {
    case 'completed': {
      return <CheckCircleIcon size={14} weight="fill" />
    }
    case 'failed': {
      return <XCircleIcon size={14} weight="fill" />
    }
    case 'running': {
      return <span className={styles.runningStatusDot} aria-hidden="true" />
    }
    case 'skipped': {
      return <WarningCircleIcon size={14} weight="fill" />
    }
    default: {
      return <CircleIcon size={14} weight="bold" />
    }
  }
}

function isDuplicateStepObjective(step: PlanStepPreview): boolean {
  return !!step.objective && normalizeInline(step.objective) === normalizeInline(step.title)
}

function isWorkspaceTargetObjective(objective: Nullable<string>): boolean {
  const normalized = objective ? normalizeInline(objective).toLowerCase() : ''

  if (!normalized) return false

  return (
    /^(写入|保存|输出|生成到).*(system|系统|session|会话).*(工区|工作区)$/.test(normalized) ||
    /^(write|save|output|export).*\b(system workspace|system work area)\b/.test(normalized)
  )
}

function getVisibleStepObjective(step: PlanStepPreview): Nullable<string> {
  if (isDuplicateStepObjective(step) || isWorkspaceTargetObjective(step.objective)) return null

  return step.objective
}

function getVisiblePlanDetail(detail: Nullable<string>): Nullable<string> {
  return isWorkspaceTargetObjective(detail) ? null : detail
}

function getCurrentPlanStep(steps: PlanStepPreview[]): Nullable<PlanStepPreview> {
  return toNullable(
    steps.find((step) => getStepTone(step.status) === 'running') ??
      steps.find((step) => getStepTone(step.status) === 'pending')
  )
}

function PlanToolSubtitle({
  currentStep,
  explanation,
}: {
  currentStep: Nullable<PlanStepPreview>
  explanation: Nullable<string>
}): Nullable<React.ReactElement> {
  const visibleExplanation = getVisiblePlanDetail(explanation)

  if (!currentStep)
    return visibleExplanation ? (
      <Paragraph spacing="none" className={styles.currentDetail} title={visibleExplanation}>
        {visibleExplanation}
      </Paragraph>
    ) : null

  const detail = getVisibleStepObjective(currentStep) ?? visibleExplanation

  return detail ? (
    <Paragraph spacing="none" className={styles.currentDetail} title={detail}>
      {detail}
    </Paragraph>
  ) : null
}

function getPlanInlineDetail(
  currentStep: Nullable<PlanStepPreview>,
  explanation: Nullable<string>
): Nullable<string> {
  const visibleExplanation = getVisiblePlanDetail(explanation)

  if (!currentStep) return visibleExplanation

  return getVisibleStepObjective(currentStep) ?? visibleExplanation
}

function PlanStepsPreview({
  steps,
  compact = false,
}: {
  steps: PlanStepPreview[]
  compact?: boolean
}): Nullable<React.ReactElement> {
  const { t } = useConversationI18n()

  if (isEmpty(steps))
    return (
      <Paragraph spacing="none" className={styles.empty}>
        {t('toolSummary.planNoSteps')}
      </Paragraph>
    )

  return (
    <ol className={cx('planList', compact && 'planListCompact')}>
      {steps.map((step, index) => {
        const tone = getStepTone(step.status)
        const objective = getVisibleStepObjective(step)

        return (
          <li
            key={step.id ?? `${index}:${step.title}`}
            className={cx('planStep', `planStep${tone[0].toUpperCase()}${tone.slice(1)}`)}
          >
            <span className={styles.stepIcon} aria-hidden="true">
              {getStepIcon(tone)}
            </span>
            <div className={styles.stepBody}>
              <div className={styles.stepHeader}>
                <Paragraph spacing="none" className={styles.stepTitle}>
                  {step.title}
                </Paragraph>
                <Text className={styles.stepStatus}>{getStatusLabel(step.status, t)}</Text>
              </div>
              {!!objective && (
                <Paragraph spacing="none" className={styles.stepObjective}>
                  {objective}
                </Paragraph>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

const PlanToolRender = memo(
  ({
    block,
    compact = false,
    variant = 'card',
  }: {
    block: ToolCallBlock
    compact?: boolean
    variant?: PlanToolRenderVariant
    sessionId?: string
    planUpdateIndex?: number
  }): React.ReactElement => {
    const { locale } = useConversationI18n()
    const translatorRuntime = useConversationTranslatorRuntime()
    const steps = getPlanToolBlockSteps(block)
    const explanation = getPlanToolBlockExplanation(block)
    const tone = getToolTone(block, steps)
    const displayName = getToolDisplayName(block.toolName, locale, translatorRuntime)
    const hasError = !!block.error
    const currentStep = hasError ? null : getCurrentPlanStep(steps)
    const inlineDetail = hasError ? null : getPlanInlineDetail(currentStep, explanation)

    if (variant === 'plain')
      return (
        <section
          className={cx('plainRoot', tone, compact && 'plainRootCompact')}
          aria-label={displayName}
        >
          <div className={styles.plainHeader}>
            <span className={styles.plainIcon} aria-hidden="true">
              <ListChecksIcon size={14} weight="bold" />
            </span>
            <div className={styles.plainTitleGroup}>
              <div className={styles.plainTitleRow}>
                <Text className={styles.plainTitle}>{displayName}</Text>
                {!!currentStep && (
                  <Text className={styles.currentHeaderSummary} title={currentStep.title}>
                    {currentStep.title}
                  </Text>
                )}
                {!!inlineDetail && (
                  <Text className={styles.currentInlineDetail} title={inlineDetail}>
                    {inlineDetail}
                  </Text>
                )}
              </div>
              {hasError && (
                <Paragraph spacing="none" className={styles.errorText} title={block.error}>
                  {block.error}
                </Paragraph>
              )}
            </div>
          </div>
          {!hasError && (
            <div className={styles.plainBody}>
              <PlanStepsPreview steps={steps} compact={compact} />
            </div>
          )}
        </section>
      )

    return (
      <ToolDisclosureCard
        className={cx('root', tone, compact && 'compactRoot')}
        statusTone={tone}
        defaultOpen
        showCaret
        contentMaxHeight={optionalWhenLazy(compact, () => 360)}
        leadingIcon={<ListChecksIcon size={12} className={styles.toolIcon} />}
        title={displayName}
        meta={optionalWhenLazy(currentStep, () => (
          <Text className={styles.currentHeaderSummary} title={currentStep!.title}>
            {currentStep!.title}
          </Text>
        ))}
        subtitle={
          hasError ? (
            <Paragraph spacing="none" className={styles.errorText} title={block.error}>
              {block.error}
            </Paragraph>
          ) : (
            <PlanToolSubtitle currentStep={currentStep} explanation={explanation} />
          )
        }
      >
        {!hasError && (
          <div className={styles.body}>
            <PlanStepsPreview steps={steps} compact={compact} />
          </div>
        )}
      </ToolDisclosureCard>
    )
  }
)

PlanToolRender.displayName = 'PlanToolRender'

export { PlanToolRender }
