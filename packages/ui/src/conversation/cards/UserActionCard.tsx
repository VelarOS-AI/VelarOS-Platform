import { type ReactElement, useMemo } from 'react'
import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  CheckIcon,
  DatabaseIcon,
  FolderOpenIcon,
  InfoIcon,
  ListChecksIcon,
  PaperPlaneTiltIcon,
  PencilSimpleLineIcon,
  PuzzlePieceIcon,
  SidebarSimpleIcon,
  TargetIcon,
  WarningCircleIcon,
  WrenchIcon,
  XCircleIcon,
  XIcon,
} from '@phosphor-icons/react'

import { StyleUtils } from '@velaros-ai/ui'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Label } from '@velaros-ai/ui/primitives/display/Label'
import { Checkbox } from '@velaros-ai/ui/primitives/forms/Checkbox'
import { Input } from '@velaros-ai/ui/primitives/forms/Input'
import { Radio, RadioGroup } from '@velaros-ai/ui/primitives/forms/RadioGroup'
import { Select } from '@velaros-ai/ui/primitives/forms/Select'
import { Textarea } from '@velaros-ai/ui/primitives/forms/Textarea'
import { ActionCard, ActionCardIconButton } from '@velaros-ai/ui/product/layout/ActionCard'
import { CardTextButton } from '@velaros-ai/ui/product/layout/CardKit'

import { useConversationI18n } from '../i18n'
import type {
  FormDraftValue,
  FormDraftValues,
  FormErrors,
  UserActionCardView,
  UserActionEntry,
  UserActionResolution,
} from '../projection'
import { useConversationAutoCollapseHold } from '../react-hooks/conversationScrollFollow'

import {
  fieldHtmlId,
  getDefaultActionIcon,
  getTextActionLabel,
  resolveUserActionCardVisualIcon,
  selectCardTone,
  shouldForceDisableConsumedUserActionCard,
  shouldRenderTextAction,
  type UserActionCardVisualIcon,
  userActionCardVisualIconClassName,
} from './userActionCardPresentation'

import styles from './UserActionCard.module.css'

import type {
  UserActionCardAction,
  UserActionFormField,
} from '#contracts'
import { isArray, isBoolean, isNonBlankString, isString, optionalWhen, optionalWhenLazy } from '#internal/runtime'

const cx = StyleUtils.bindCx(styles)

export type { UserActionResolution }

function renderCardIcon(icon: UserActionCardVisualIcon): ReactElement {
  switch (icon) {
    case 'success':
      return <CheckCircleIcon size={17} weight="fill" />
    case 'danger':
      return <XCircleIcon size={17} weight="fill" />
    case 'warning':
      return <WarningCircleIcon size={17} weight="fill" />
    case 'plugin':
      return <PuzzlePieceIcon size={17} weight="fill" />
    case 'plan':
      return <ListChecksIcon size={17} weight="bold" />
    case 'target':
      return <TargetIcon size={17} weight="bold" />
    case 'tool':
      return <WrenchIcon size={17} weight="duotone" />
    case 'workspace':
      return <FolderOpenIcon size={17} weight="duotone" />
    case 'memory':
      return <DatabaseIcon size={17} weight="duotone" />
    case 'input':
      return <PencilSimpleLineIcon size={17} weight="fill" />
    case 'info':
    default:
      return <InfoIcon size={17} weight="fill" />
  }
}

function renderActionIcon(action: UserActionCardAction, completed: boolean): ReactElement {
  if (completed) return <CheckIcon size={15} weight="bold" />

  const icon = action.icon ?? getDefaultActionIcon(action)

  switch (icon) {
    case 'plugin':
      return <PuzzlePieceIcon size={15} weight="bold" />
    case 'plan':
      return <ListChecksIcon size={15} weight="bold" />
    case 'target':
      return <TargetIcon size={15} weight="bold" />
    case 'reject':
      return <XIcon size={15} weight="bold" />
    case 'tool':
      return <WrenchIcon size={15} weight="bold" />
    case 'workspace':
      return <FolderOpenIcon size={15} weight="bold" />
    case 'memory':
      return <DatabaseIcon size={15} weight="bold" />
    case 'open':
      return <ArrowSquareOutIcon size={15} weight="bold" />
    case 'send':
      return <PaperPlaneTiltIcon size={15} weight="bold" />
    case 'input':
      return <PencilSimpleLineIcon size={15} weight="bold" />
    case 'confirm':
    default:
      return <CheckIcon size={15} weight="bold" />
  }
}

function isPlanChoiceCard({
  actionEntries,
  cardVisualIcon,
  blocking,
}: {
  actionEntries: readonly UserActionEntry[]
  cardVisualIcon: UserActionCardVisualIcon
  blocking: boolean
}): boolean {
  if (!blocking || cardVisualIcon !== 'plan') return false

  const hasImplementationChoice = actionEntries.some((entry) => entry.action.kind === 'acknowledge')
  const hasAdjustmentChoice = actionEntries.some(
    (entry) => entry.action.kind === 'reject' || entry.action.kind === 'submit_input'
  )

  return hasImplementationChoice && hasAdjustmentChoice
}

// 独占整行的字段类型（内容较高/较宽）；其余短字段在紧凑网格里自动并排。
const FullWidthFormFieldTypes = new Set<UserActionFormField['type']>([
  'textarea',
  'radio',
  'checkboxes',
])

function UserActionFormFields({
  cardId,
  fields,
  values,
  errors,
  disabled,
  onChange,
}: {
  cardId: string
  fields: readonly UserActionFormField[]
  values: FormDraftValues
  errors: FormErrors
  disabled: boolean
  onChange: (fieldId: string, value: FormDraftValue) => void
}): ReactElement {
  const { t } = useConversationI18n()

  return (
    <div className={styles.formCompact}>
      {fields.map((field) => {
        const id = fieldHtmlId(cardId, field.id)
        const error = errors[field.id]
        const value = values[field.id]
        // 紧凑布局：短字段（text/number/select/checkbox）自动并排，长字段（textarea/radio/checkboxes）独占整行。
        const fieldClassName = cx('formField', FullWidthFormFieldTypes.has(field.type) && 'formFieldFull')
        const label = (
          <div className={styles.formLabelRow}>
            <Label className={styles.formLabel} htmlFor={id}>
              {field.label}
            </Label>
          </div>
        )
        const help = error ? (
          <div className={styles.formError}>{error}</div>
        ) : !!field.help && (
          <div className={styles.formHelp}>{field.help}</div>
        )

        switch (field.type) {
          case 'textarea':
            return (
              <div key={field.id} className={fieldClassName}>
                {label}
                <Textarea
                  id={id}
                  size="sm"
                  className={styles.formTextarea}
                  disabled={disabled}
                  value={isString(value) ? value : ''}
                  maxLength={field.maxLength}
                  placeholder={field.placeholder}
                  aria-invalid={!!error}
                  onChange={(event) => onChange(field.id, event.currentTarget.value)}
                />
                {help}
              </div>
            )
          case 'select':
            return (
              <div key={field.id} className={fieldClassName}>
                {label}
                <Select
                  id={id}
                  size="sm"
                  disabled={disabled}
                  value={optionalWhen(isNonBlankString, value)}
                  placeholder={field.placeholder ?? t('userActionForm.selectPlaceholder')}
                  options={field.options ?? []}
                  onChange={(next) => onChange(field.id, next)}
                />
                {help}
              </div>
            )
          case 'radio':
            return (
              <div key={field.id} className={fieldClassName}>
                {label}
                <RadioGroup
                  className={styles.formOptionGroup}
                  value={isString(value) ? value : ''}
                  disabled={disabled}
                  onValueChange={(next) => onChange(field.id, next)}
                >
                  {(field.options ?? []).map((option) => (
                    <div key={option.value} className={styles.formOptionRow}>
                      <Radio size="sm" value={option.value} />
                      <span className={styles.formOptionText}>
                        <span className={styles.formOptionLabel}>
                          {option.label}
                          {!!option.recommended && (
                            <span className={styles.formOptionRecommended}>
                              {t('userActionForm.recommended')}
                            </span>
                          )}
                        </span>
                        {!!option.description && (
                          <span className={styles.formOptionDescription}>{option.description}</span>
                        )}
                      </span>
                    </div>
                  ))}
                </RadioGroup>
                {help}
              </div>
            )
          case 'checkbox':
            return (
              <div key={field.id} className={fieldClassName}>
                <div className={styles.formCheckboxRow}>
                  <Checkbox
                    id={id}
                    size="sm"
                    checked={isBoolean(value) ? value : false}
                    disabled={disabled}
                    onCheckedChange={(next) => onChange(field.id, next)}
                  />
                  <span className={styles.formOptionText}>
                    <span className={styles.formOptionLabel}>{field.label}</span>
                    {!!field.help && (
                      <span className={styles.formOptionDescription}>{field.help}</span>
                    )}
                  </span>
                </div>
                {!!error && <div className={styles.formError}>{error}</div>}
              </div>
            )
          case 'checkboxes': {
            const selectedValues = isArray(value) ? value : []

            return (
              <div key={field.id} className={fieldClassName}>
                {label}
                <div className={styles.formOptionGroup}>
                  {(field.options ?? []).map((option) => {
                    const checked = selectedValues.includes(option.value)

                    return (
                      <div key={option.value} className={styles.formOptionRow}>
                        <Checkbox
                          size="sm"
                          checked={checked}
                          disabled={disabled}
                          onCheckedChange={(next) =>
                            onChange(
                              field.id,
                              next
                                ? [...selectedValues, option.value]
                                : selectedValues.filter((item) => item !== option.value)
                            )
                          }
                        />
                        <span className={styles.formOptionText}>
                          <span className={styles.formOptionLabel}>
                            {option.label}
                            {!!option.recommended && (
                              <span className={styles.formOptionRecommended}>
                                {t('userActionForm.recommended')}
                              </span>
                            )}
                          </span>
                          {!!option.description && (
                            <span className={styles.formOptionDescription}>
                              {option.description}
                            </span>
                          )}
                        </span>
                      </div>
                    )
                  })}
                </div>
                {help}
              </div>
            )
          }
          default:
            return (
              <div key={field.id} className={fieldClassName}>
                {label}
                <Input
                  id={id}
                  size="sm"
                  type="text"
                  inputMode={optionalWhenLazy(field.type === 'number', () => 'decimal')}
                  disabled={disabled}
                  value={isString(value) ? value : ''}
                  maxLength={field.maxLength}
                  placeholder={field.placeholder}
                  aria-invalid={!!error}
                  onChange={(event) => onChange(field.id, event.currentTarget.value)}
                />
                {help}
              </div>
            )
        }
      })}
    </div>
  )
}

export function UserActionCard({
  view: viewModel,
  onOpenArtifact,
  onDismiss,
  disabled = false,
}: {
  /** 宿主 hook `useUserActionCardViewModel` 的输出投影（有状态半壁注入进来）。 */
  view: UserActionCardView
  onOpenArtifact?: (path: string) => unknown
  onDismiss?: () => void
  disabled?: boolean
}): Nullable<ReactElement> {
  const { t } = useConversationI18n()

  const cardVisualIcon = useMemo(
    () => resolveUserActionCardVisualIcon(viewModel.card),
    [viewModel.card]
  )
  const cardIconClassName = useMemo(
    () => cx('cardIcon', userActionCardVisualIconClassName(cardVisualIcon)),
    [cardVisualIcon]
  )
  // 倒计时进度条以 createdAt 为锚：用负 animation-delay 让它从「已过去的位置」接着走，重挂载不重头。
  const timeoutFillDelayMs = useMemo(() => {
    const total = viewModel.effectiveTimeoutMs
    if (!total || total <= 0 || !viewModel.card.createdAt) return 0
    return -Math.min(total, Math.max(0, Date.now() - viewModel.card.createdAt))
     
  }, [viewModel.card.id, viewModel.card.createdAt, viewModel.effectiveTimeoutMs])
  const isModePreflightCard = cardVisualIcon === 'plan' || cardVisualIcon === 'target'
  const shouldRenderPlanChoiceCard = isPlanChoiceCard({
    actionEntries: viewModel.actionEntries,
    cardVisualIcon,
    blocking: viewModel.card.blocking,
  })
  // 表单卡：不要图标/标题/描述那套卡壳，只保留表单内容 + 右下角一个「提交」按钮。
  const isFormCard = !!viewModel.card.form && !shouldRenderPlanChoiceCard
  const formSubmitEntry = isFormCard
    ? viewModel.actionEntries.find((entry) => entry.action.kind === 'submit_form')
    : undefined
  // 计时到点的自动折叠也是界面自己的变化：读者已上滑解除跟随时不收，免得他正看的卡片突然缩成一行。
  const holdExpandedForReader = useConversationAutoCollapseHold(viewModel.autoCollapsed)

  if (viewModel.isHidden) return null

  // 自动折叠：纯展示的防堆积收口。按钮并没有失效，只是收起来了——所以整行本身就是展开入口，
  // 而不是一块"已超时"的墓碑。旧实现在这一刻把卡永久禁用并写盘，那是不可逆的能力剥夺。
  if (viewModel.autoCollapsed && !holdExpandedForReader)
    return (
      <div className={styles.collapsedFrame}>
        <button
          type="button"
          className={styles.collapsedRow}
          onClick={viewModel.expandCard}
          title={t('common.expand')}
        >
          <span className={styles.collapsedIcon}>{renderCardIcon(cardVisualIcon)}</span>
          <span className={styles.collapsedTitle}>{viewModel.card.title}</span>
          <span className={styles.collapsedHint}>{t('common.expand')}</span>
        </button>
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

  if (isFormCard && viewModel.card.form)
    return (
      <div
        className={cx(
          'cardFrame',
          viewModel.isConsumed &&
            shouldForceDisableConsumedUserActionCard(viewModel.isConsumed, viewModel.isTimedOut) &&
            styles.cardConsumed
        )}
      >
        <div className={styles.formCardPanel}>
          <UserActionFormFields
            cardId={viewModel.card.id}
            fields={viewModel.formFields}
            values={viewModel.formValues}
            errors={viewModel.formErrors}
            disabled={viewModel.isFormDisabled}
            onChange={viewModel.handleFormFieldChange}
          />
          {!!formSubmitEntry && (
            <div className={styles.formSubmitRow}>
              <CardTextButton
                tone="approve"
                disabled={viewModel.isActionButtonDisabled(formSubmitEntry)}
                onClick={() => viewModel.submitAction(formSubmitEntry)}
              >
                {t('userActionForm.submit')}
              </CardTextButton>
            </div>
          )}
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

  // 固定模版:带文档产物的卡(如 proposal:review)不把正文塞进卡里,改成「点标题开侧边栏预览」
  // + 标题右侧一个侧边栏图标示意可点。侧边栏预览走既有 onOpenArtifact(= 打开工作区文档)。
  const openableArtifactPath =
    !!viewModel.card.artifact?.path && !!onOpenArtifact ? viewModel.card.artifact.path : null
  const openArtifact = (): void => {
    if (openableArtifactPath) onOpenArtifact?.(openableArtifactPath)
  }
  const titleNode: ReactElement | string = openableArtifactPath ? (
    <button
      type="button"
      className={styles.openableTitle}
      onClick={openArtifact}
      title={viewModel.card.artifact?.label ?? t('common.open')}
    >
      <span className={styles.openableTitleText}>{viewModel.card.title}</span>
      <SidebarSimpleIcon
        size={15}
        weight="bold"
        className={styles.openableTitleIcon}
        aria-hidden="true"
      />
    </button>
  ) : (
    viewModel.card.title
  )

  const renderSkipButton = (className: string): Nullable<ReactElement> => {
    if (cardVisualIcon === 'plugin') return null
    if (!viewModel.shouldShowSkipButton) return null

    return (
      <CardTextButton
        tone="neutral"
        hoverBackground={false}
        className={className}
        disabled={
          viewModel.interactionDisabled || viewModel.settled || !!viewModel.pendingActionKey
        }
        onClick={viewModel.skipCard}
      >
        {t('common.skip')}
      </CardTextButton>
    )
  }
  const renderChoiceActions = (): Nullable<ReactElement> => {
    if (!viewModel.shouldShowCardActions) return null

    return (
      <div className={styles.choiceActionList}>
        {viewModel.actionEntries.map((entry, index) => {
          const { action } = entry
          const isCompleted = viewModel.completedActionKey === entry.key
          const label = shouldRenderTextAction(action)
            ? getTextActionLabel(action, t)
            : isCompleted && action.completedLabel
              ? action.completedLabel
              : action.label
          const buttonDisabled = viewModel.isActionButtonDisabled(entry)

          return (
            <button
              key={entry.key}
              type="button"
              className={cx(
                'choiceActionButton',
                action.kind === 'reject' && 'choiceActionButtonReject'
              )}
              disabled={buttonDisabled}
              onClick={() => viewModel.submitAction(entry)}
            >
              <span className={styles.choiceActionIndex}>{index + 1}</span>
              <span className={styles.choiceActionLabel}>{label}</span>
            </button>
          )
        })}
      </div>
    )
  }

  return (
    <div
      className={cx(
        'cardFrame',
        shouldRenderPlanChoiceCard && 'cardFrameChoice',
        viewModel.isConsumed &&
          shouldForceDisableConsumedUserActionCard(viewModel.isConsumed, viewModel.isTimedOut) &&
          styles.cardConsumed
      )}
      onMouseEnter={() => viewModel.setTimeoutPaused(true)}
      onMouseLeave={() => viewModel.setTimeoutPaused(false)}
    >
      <ActionCard
        className={cx(
          'card',
          shouldRenderPlanChoiceCard && 'choiceCard',
          'velar-action-card-chromeless'
        )}
        tone={selectCardTone(viewModel.card)}
        icon={shouldRenderPlanChoiceCard ? null : renderCardIcon(cardVisualIcon)}
        iconClassName={cardIconClassName}
        title={titleNode}
        description={
          viewModel.completedEntry?.action.completedDescription ?? viewModel.card.description
        }
        actionsClassName={styles.actions}
        actions={
          shouldRenderPlanChoiceCard ? (
            renderSkipButton(styles.skipTextButton)
          ) : (!shouldRenderPlanChoiceCard && viewModel.shouldShowCardActions) && (
            <>
              {viewModel.actionEntries.map((entry) => {
                const { action } = entry
                const isCompleted = viewModel.completedActionKey === entry.key
                const label = shouldRenderTextAction(action)
                  ? getTextActionLabel(action, t)
                  : isCompleted && action.completedLabel
                    ? action.completedLabel
                    : action.label
                const buttonDisabled = viewModel.isActionButtonDisabled(entry)

                if (isModePreflightCard && shouldRenderTextAction(action))
                  return (
                    <ActionCardIconButton
                      key={entry.key}
                      label={label}
                      disabled={buttonDisabled}
                      className={cx(
                        'preflightActionButton',
                        action.kind === 'reject' && 'preflightActionButtonReject'
                      )}
                      onClick={() => viewModel.submitAction(entry)}
                    >
                      {renderActionIcon(action, isCompleted)}
                    </ActionCardIconButton>
                  )

                if (shouldRenderTextAction(action))
                  // 只留文字（卡片左侧已有语义图标）；对齐确认卡的配色：拒绝红、其它正向动作绿。
                  return (
                    <CardTextButton
                      key={entry.key}
                      tone={action.kind === 'reject' ? 'reject' : 'approve'}
                      disabled={buttonDisabled}
                      onClick={() => viewModel.submitAction(entry)}
                    >
                      {label}
                    </CardTextButton>
                  )

                return (
                  <ActionCardIconButton
                    key={entry.key}
                    label={label}
                    disabled={buttonDisabled}
                    tone={action.kind === 'reject' ? 'danger' : 'default'}
                    onClick={() => viewModel.submitAction(entry)}
                  >
                    {renderActionIcon(action, isCompleted)}
                  </ActionCardIconButton>
                )
              })}
              {renderSkipButton(styles.skipTextButton)}
            </>
          )
        }
      >
        {shouldRenderPlanChoiceCard ? renderChoiceActions() : null}
        {!!viewModel.card.form && (
          <UserActionFormFields
            cardId={viewModel.card.id}
            fields={viewModel.formFields}
            values={viewModel.formValues}
            errors={viewModel.formErrors}
            disabled={viewModel.isFormDisabled}
            onChange={viewModel.handleFormFieldChange}
          />
        )}
        {!!viewModel.activeInputEntry && (
          <div className={styles.inputPanel}>
            <Input
              size="sm"
              className={styles.inputLine}
              disabled={viewModel.isInputPanelDisabled}
              value={viewModel.inputValue}
              maxLength={optionalWhenLazy(
                viewModel.activeInputEntry.action.kind === 'submit_input' ||
                  viewModel.activeInputEntry.action.kind === 'reject',
                () =>
                  (
                    viewModel.activeInputEntry!.action as Extract<
                      typeof viewModel.activeInputEntry.action,
                      { kind: 'submit_input' | 'reject' }
                    >
                  ).input?.maxLength
              )}
              placeholder={optionalWhenLazy(
                viewModel.activeInputEntry.action.kind === 'submit_input' ||
                  viewModel.activeInputEntry.action.kind === 'reject',
                () =>
                  (
                    viewModel.activeInputEntry!.action as Extract<
                      typeof viewModel.activeInputEntry.action,
                      { kind: 'submit_input' | 'reject' }
                    >
                  ).input?.placeholder
              )}
              onChange={(event) => viewModel.setInputValue(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (
                  event.key !== 'Enter' ||
                  viewModel.isInputSubmitDisabled(viewModel.activeInputEntry!)
                )
                  return
                viewModel.submitAction(viewModel.activeInputEntry!, viewModel.inputValue)
              }}
              autoFocus
            />
            <div className={styles.inputActions}>
              {renderSkipButton(styles.skipTextButton)}
              <Button
                size="sm"
                variant="ghost"
                className={styles.inputTextButton}
                disabled={viewModel.isInputPanelDisabled}
                onClick={viewModel.cancelInput}
              >
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                variant={
                  viewModel.activeInputEntry.action.kind === 'reject' ? 'destructiveGhost' : 'ghost'
                }
                className={styles.inputTextButton}
                disabled={
                  viewModel.isInputPanelDisabled ||
                  viewModel.isInputSubmitDisabled(viewModel.activeInputEntry)
                }
                onClick={() =>
                  viewModel.submitAction(viewModel.activeInputEntry!, viewModel.inputValue)
                }
              >
                {getTextActionLabel(viewModel.activeInputEntry.action, t)}
              </Button>
            </div>
          </div>
        )}
        {!!(viewModel.effectiveTimeoutMs &&
        viewModel.effectiveTimeoutMs > 0 &&
        !viewModel.settled &&
        !viewModel.interactionDisabled &&
        !disabled) && (
          <div className={styles.timeoutTrack} aria-hidden="true">
            <span
              className={`${styles.timeoutFill} ${viewModel.timeoutPaused ? styles.timeoutFillPaused : ''}`}
              style={{
                animationDuration: `${viewModel.effectiveTimeoutMs}ms`,
                animationDelay: `${timeoutFillDelayMs}ms`,
              }}
            />
          </div>
        )}
      </ActionCard>
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
