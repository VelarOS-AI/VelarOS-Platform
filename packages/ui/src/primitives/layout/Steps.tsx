/**
 * 步骤指示器（流程进度）。
 *
 * variants（封闭枚举，全仓共用一套）：`direction` = `horizontal | vertical`。
 * 样式：`.velar-steps` · 见 styles/components/。
 */
import React, { memo } from 'react'
import { CheckIcon, SpinnerGapIcon, XIcon } from '@phosphor-icons/react'
import { cva,type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'
import { isPresent } from '../../lib/runtime'
export type StepStatus = 'wait' | 'process' | 'finish' | 'error'

export interface StepItem {
  title: React.ReactNode
  description?: React.ReactNode
  status?: StepStatus
}

const stepsVariants = cva('velar-steps', {
  variants: {
    direction: {
      horizontal: 'velar-steps-horizontal',
      vertical: 'velar-steps-vertical',
    },
  },
  defaultVariants: {
    direction: 'horizontal',
  },
})

export interface StepsProps extends React.ComponentProps<'div'>, VariantProps<typeof stepsVariants> {
  current: number
  items: StepItem[]
}

function resolveStatus(item: StepItem, index: number, current: number): StepStatus {
  if (isPresent(item.status)) return item.status
  if (index < current) return 'finish'
  if (index === current) return 'process'
  return 'wait'
}

export const Steps = memo(
  ({ className, direction, current, items, ...props }: StepsProps): React.ReactElement => {
    if (direction === 'vertical') return (
        <div data-slot="steps" className={cn(stepsVariants({ direction }), className)} {...props}>
          {items.map((item, index) => {
            const status = resolveStatus(item, index, current)
            const iconClass = cn(
              'velar-steps-icon',
              status === 'wait' && 'velar-steps-icon-wait',
              status === 'process' && 'velar-steps-icon-process',
              status === 'finish' && 'velar-steps-icon-finish',
              status === 'error' && 'velar-steps-icon-error'
            )
            let icon: React.ReactNode = <span aria-hidden>{index + 1}</span>
            if (status === 'finish') {
              icon = <CheckIcon size={13} weight="bold" aria-hidden />
            } else if (status === 'process') {
              icon = <SpinnerGapIcon size={13} className={'velar-steps-spin-glyph'} aria-hidden />
            } else if (status === 'error') {
              icon = <XIcon size={13} weight="bold" aria-hidden />
            }

            return (
              <div key={index} className={'velar-steps-vertical-step'}>
                <div className={'velar-steps-vertical-rail'}>
                  <div className={iconClass}>{icon}</div>
                  {(index < items.length - 1) && (
                    <div
                      className={cn('velar-steps-vertical-line', index < current && 'velar-steps-vertical-line-done')}
                    />
                  )}
                </div>
                <div className={'velar-steps-vertical-body'}>
                  <div className={'velar-steps-title'}>{item.title}</div>
                  {isPresent(item.description) && (
                    <div className={'velar-steps-description'}>{item.description}</div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )

    return (
      <div data-slot="steps" className={cn(stepsVariants({ direction: 'horizontal' }), className)} {...props}>
        {items.map((item, index) => {
          const status = resolveStatus(item, index, current)
          const iconClass = cn(
            'velar-steps-icon',
            status === 'wait' && 'velar-steps-icon-wait',
            status === 'process' && 'velar-steps-icon-process',
            status === 'finish' && 'velar-steps-icon-finish',
            status === 'error' && 'velar-steps-icon-error'
          )
          const beforeDone = index > 0 && current >= index
          const afterDone = current > index

          let icon: React.ReactNode = <span aria-hidden>{index + 1}</span>
          if (status === 'finish') {
            icon = <CheckIcon size={13} weight="bold" aria-hidden />
          } else if (status === 'process') {
            icon = <SpinnerGapIcon size={13} className={'velar-steps-spin-glyph'} aria-hidden />
          } else if (status === 'error') {
            icon = <XIcon size={13} weight="bold" aria-hidden />
          }

          return (
            <div key={index} className={'velar-steps-step'}>
              <div className={'velar-steps-track-row'}>
                <div
                  className={cn('velar-steps-track-before', beforeDone && 'velar-steps-track-before-done')}
                  aria-hidden
                />
                <div className={'velar-steps-icon-cell'}>
                  <div className={iconClass}>{icon}</div>
                </div>
                <div
                  className={cn('velar-steps-track-after', afterDone && 'velar-steps-track-after-done')}
                  aria-hidden
                />
              </div>
              <div className={'velar-steps-copy'}>
                <div className={'velar-steps-title'}>{item.title}</div>
                {isPresent(item.description) && (
                  <div className={'velar-steps-description'}>{item.description}</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    )
  }
)

Steps.displayName = 'Steps'
