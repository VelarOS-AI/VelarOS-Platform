import { type ReactElement, useMemo, useState } from 'react'
import { CaretLeftIcon, CaretRightIcon, PaperPlaneTiltIcon, XIcon } from '@phosphor-icons/react'

import { StyleUtils } from '@velaros-ai/ui'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Input } from '@velaros-ai/ui/primitives/forms/Input'

import { useConversationI18n } from '../i18n'
import type { UserActionCardView } from '../projection'

import styles from './UserActionCard.module.css'

import type { UserActionFormField } from '#contracts'
import { isArray, isBlank,isEmpty, isString,toNullable } from '#internal/runtime'

const cx = StyleUtils.bindCx(styles)

/** 一"页"=一道问题：主字段（radio/checkboxes）+ 可选的自由输入字段（id 以 _other 结尾）。 */
function groupFieldsIntoPages(fields: readonly UserActionFormField[]): UserActionFormField[][] {
  const pages: UserActionFormField[][] = []
  for (const field of fields) {
    if (field.id.endsWith('_other') && !isEmpty(pages)) {
      pages[pages.length - 1]!.push(field)
    } else {
      pages.push([field])
    }
  }
  return pages
}

function isFieldAnswered(field: Nullable<UserActionFormField>, value: unknown): boolean {
  if (!field) return false
  if (isArray(value)) return !isEmpty(value)
  if (isString(value)) return !isBlank(value.trim())
  return false
}

/** ask_user 提问卡：把多道问题放进一个左右切换的轮播，逐题作答，全部填完后在最后一页统一发送。 */
export function AskUserCarousel({
  view: viewModel,
  onDismiss,
}: {
  /** 宿主 hook `useUserActionCardViewModel` 的输出投影（有状态半壁注入进来）。 */
  view: UserActionCardView
  onDismiss?: () => void
}): Nullable<ReactElement> {
  const { t } = useConversationI18n()

  const pages = useMemo(() => groupFieldsIntoPages(viewModel.formFields), [viewModel.formFields])
  const [pageIndex, setPageIndex] = useState(0)
  const safeIndex = Math.min(pageIndex, Math.max(0, pages.length - 1))
  const currentPage = pages[safeIndex] ?? []
  const isLast = safeIndex >= pages.length - 1

  const isPageAnswered = (page: readonly UserActionFormField[]): boolean =>
    page.some((field) => isFieldAnswered(field, viewModel.formValues[field.id]))
  const allAnswered = pages.every(isPageAnswered)

  // 作答后（settled / 已消费 / 被禁用）锁定选择与发送，但仍允许左右翻页回看各题答案——面板不消失，只禁用。
  const locked =
    viewModel.interactionDisabled ||
    viewModel.settled ||
    !!viewModel.pendingActionKey ||
    viewModel.isFormDisabled
  const formDisabled = locked
  const sendDisabled = locked || !allAnswered
  const submitEntry = viewModel.actionEntries.find((entry) => entry.action.kind === 'submit_form')

  const primaryField =
    toNullable(currentPage.find(
      (field) => field.type === 'radio' || field.type === 'checkboxes' || field.type === 'select'
    ))
  const otherField =
    toNullable(currentPage.find(
      (field) => field.type === 'text' || field.type === 'textarea' || field.type === 'number'
    ))
  const isMulti = primaryField?.type === 'checkboxes'

  const rawSelected = primaryField ? viewModel.formValues[primaryField.id] : undefined
  const selectedValues: string[] = isArray(rawSelected)
    ? rawSelected.map(String)
    : isString(rawSelected) && !isBlank(rawSelected)
      ? [rawSelected]
      : []
  const isSelected = (value: string): boolean => selectedValues.includes(value)
  const toggleOption = (value: string): void => {
    if (!primaryField || formDisabled) return
    if (isMulti) {
      const next = isSelected(value)
        ? selectedValues.filter((item) => item !== value)
        : [...selectedValues, value]
      viewModel.handleFormFieldChange(primaryField.id, next)
    } else {
      viewModel.handleFormFieldChange(primaryField.id, isSelected(value) ? '' : value)
    }
  }

  const otherValue = otherField ? viewModel.formValues[otherField.id] : undefined

  const goPrev = (): void =>
    setPageIndex((current) => Math.max(0, Math.min(current, pages.length - 1) - 1))
  const goNext = (): void => setPageIndex((current) => Math.min(pages.length - 1, current + 1))
  const send = (): void => {
    if (!submitEntry || sendDisabled) return
    viewModel.submitAction(submitEntry)
  }

  return (
    <div className={cx('cardFrame')}>
      <div className={styles.wizardPanel}>
        {pages.length > 1 && (
          <div className={styles.wizardStepRow}>
            <span className={styles.wizardStepLabel}>
              {t('userActionForm.wizardStep', {
                current: String(safeIndex + 1),
                total: String(pages.length),
              })}
            </span>
            <div className={styles.wizardDots} aria-hidden="true">
              {pages.map((page, index) => (
                <span
                  key={index}
                  className={cx(
                    'wizardDot',
                    index === safeIndex && 'wizardDotActive',
                    isPageAnswered(page) && 'wizardDotDone'
                  )}
                />
              ))}
            </div>
          </div>
        )}

        {!!primaryField && (
          <div className={styles.wizardQuestionBlock}>
            <div className={styles.wizardQuestionRow}>
              <span className={styles.wizardQuestionNo}>{safeIndex + 1}.</span>
              <span className={styles.wizardQuestion}>{primaryField.label}</span>
              <span className={styles.wizardQuestionTag}>
                {isMulti ? t('userActionForm.wizardMulti') : t('userActionForm.wizardSingle')}
              </span>
            </div>
            <div className={styles.optionButtons}>
              {(primaryField.options ?? []).map((option, optionIndex) => {
                const selected = isSelected(option.value)
                const letter = String.fromCharCode(65 + optionIndex)
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={cx('optionButton', selected && 'optionButtonSelected')}
                    disabled={formDisabled}
                    aria-pressed={selected}
                    onClick={() => toggleOption(option.value)}
                  >
                    <span className={styles.optionLetter}>{letter}</span>
                    <span className={styles.optionBody}>
                      <span className={styles.optionButtonHeader}>
                        <span className={styles.optionButtonLabel}>{option.label}</span>
                        {!!option.recommended && (
                          <span className={styles.formOptionRecommended}>
                            {t('userActionForm.recommended')}
                          </span>
                        )}
                      </span>
                      {!!option.description && (
                        <span className={styles.optionButtonDesc}>{option.description}</span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {!!otherField && (
          <Input
            size="sm"
            className={styles.inputLine}
            disabled={formDisabled}
            value={isString(otherValue) ? otherValue : ''}
            maxLength={otherField.maxLength}
            placeholder={otherField.placeholder}
            onChange={(event) =>
              viewModel.handleFormFieldChange(otherField.id, event.currentTarget.value)
            }
          />
        )}

        <div className={styles.wizardNav}>
          <Button
            size="sm"
            variant="ghost"
            className={styles.actionTextButton}
            disabled={safeIndex === 0}
            onClick={goPrev}
          >
            <span className={styles.actionTextButtonIcon} aria-hidden="true">
              <CaretLeftIcon size={15} weight="bold" />
            </span>
            {t('userActionForm.wizardPrev')}
          </Button>

          <span className={styles.wizardNavSpacer} />

          {isLast ? (
            <Button
              size="sm"
              variant="ghost"
              className={styles.actionTextButton}
              disabled={sendDisabled}
              title={allAnswered ? undefined : t('userActionForm.wizardIncomplete')}
              onClick={send}
            >
              <span className={styles.actionTextButtonIcon} aria-hidden="true">
                <PaperPlaneTiltIcon size={15} weight="bold" />
              </span>
              {t('userActionForm.wizardSend')}
            </Button>
          ) : (
            <Button size="sm" variant="ghost" className={styles.actionTextButton} onClick={goNext}>
              {t('userActionForm.wizardNext')}
              <span className={styles.actionTextButtonIcon} aria-hidden="true">
                <CaretRightIcon size={15} weight="bold" />
              </span>
            </Button>
          )}
        </div>
      </div>
      {!!onDismiss && (
        <button
          type="button"
          className={styles.dismissButton}
          aria-label={t('sessionStickyDock.dismissAria')}
          title={t('sessionStickyDock.dismissAria')}
          onClick={onDismiss}
        >
          <XIcon size={11} weight="bold" />
        </button>
      )}
    </div>
  )
}
