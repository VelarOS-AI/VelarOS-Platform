import {
  type HTMLAttributes,
  memo,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { CaretDownIcon, CaretRightIcon, QuestionIcon } from '@phosphor-icons/react'

import { cn } from '@velaros-ai/ui/lib/cn'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { Switch } from '@velaros-ai/ui/primitives/forms/Switch'
import { BubbleTooltip } from '@velaros-ai/ui/primitives/overlays/Tooltip'
import {
  BusinessCascadingMenu,
  BusinessCascadingMenuItem,
  BusinessCascadingSubmenuSection,
} from '@velaros-ai/ui/product/menus/BusinessCascadingMenu'

import type { ConversationMessageKey as MessageKey } from '../i18n'

import type {
  ChatComposerModelRunSummary,
  ChatComposerModelSelectorControl,
  ChatComposerProviderModelSelectOption,
  ChatComposerReasoningControl,
} from './ChatComposer'
import type { ModelSelectOption } from './chatInputTypes'
import type {
  ChatInputPureChatControl,
  ChatInputRunProfileControl,
  ChatInputThinkingDepthControl,
  ChatInputThinkingVisibilityControl,
} from './chatInputTypes'
import {
  type ChatComposerCapabilityControl,
  ComposerCapabilityControls,
} from './ComposerCapabilityControls'
import {
  dispatchOnboardingComposerModelMenuOpened,
  OnboardingCloseComposerMenusEventName,
} from './composerHostEvents'
import { ComposerTierSlider } from './ComposerTierSlider'
import { useConversationComposerPort } from './conversationComposerPort'

import styles from './ChatInput.module.css'

import type { RunProfileSelectionId } from '#contracts'
import type { ReasoningLevel } from '#contracts'
import { first, isEmpty,toNullable } from '#internal/runtime'

interface ComposerRunProfileOption {
  value: RunProfileSelectionId
  labelKey: MessageKey
}

interface ComposerThinkingDepthOption {
  value: ReasoningLevel
  labelKey: MessageKey
}

export interface ComposerModelRunSelectorProps {
  t: (key: MessageKey) => string
  modelSelector?: ChatComposerModelSelectorControl
  /** 摘要按钮文案覆盖（宿主给的如实摘要优先于包内回落，见 ChatComposerModelRunSummary）。 */
  modelRunSummary?: ChatComposerModelRunSummary
  reasoning?: ChatComposerReasoningControl
  runProfile?: ChatInputRunProfileControl
  thinkingDepth?: ChatInputThinkingDepthControl
  thinkingVisibility?: ChatInputThinkingVisibilityControl
  pureChat?: ChatInputPureChatControl
  capabilityControls?: ChatComposerCapabilityControl[]
  density?: 'default' | 'compact'
}

const RunProfileOptions: ComposerRunProfileOption[] = [
  { value: 'compact', labelKey: 'chat.composerRunProfile_compact' },
  { value: 'balanced', labelKey: 'chat.composerRunProfile_balanced' },
  { value: 'expanded', labelKey: 'chat.composerRunProfile_expanded' },
]

const ThinkingDepthOptions: ComposerThinkingDepthOption[] = [
  { value: 'low', labelKey: 'chat.composerThinkingDepth_low' },
  { value: 'medium', labelKey: 'chat.composerThinkingDepth_medium' },
  { value: 'high', labelKey: 'chat.composerThinkingDepth_high' },
  { value: 'ultra', labelKey: 'chat.composerThinkingDepth_ultra' },
]

const LegacyThinkingDepthOptions: ComposerThinkingDepthOption[] = [
  { value: 'off', labelKey: 'chat.composerThinkingDepth_off' },
  ...ThinkingDepthOptions,
]

function getSelectedModelLabel(
  providerOption: Nullable<ChatComposerProviderModelSelectOption>,
  model: string
): string {
  const selectedModel = providerOption?.models.find((option) => option.value === model)
  return selectedModel?.label ?? model
}

function getProviderModelDisplayLabel(
  providerOption: ChatComposerProviderModelSelectOption,
  visibleProvider: Nullable<ChatComposerProviderModelSelectOption>,
  selectedModel: string
): string {
  const model = resolveVisibleProviderModel(providerOption, visibleProvider, selectedModel)

  return getSelectedModelLabel(providerOption, model)
}

function resolveVisibleProviderModel(
  providerOption: ChatComposerProviderModelSelectOption,
  visibleProvider: Nullable<ChatComposerProviderModelSelectOption>,
  selectedModel: string
): string {
  const candidate =
    visibleProvider?.value === providerOption.value
      ? selectedModel.trim() || providerOption.defaultModel
      : providerOption.defaultModel

  if (providerOption.models.some((option) => option.value === candidate)) return candidate

  return providerOption.defaultModel || first(providerOption.models)?.value || candidate
}

function MenuSectionHeader({ label, hint }: { label: string; hint: string }): ReactElement {
  return (
    <div className={styles.composerModelRunMenuHeaderRow}>
      <Text className={styles.composerModelRunMenuHeader}>{label}</Text>
      <BubbleTooltip
        content={<span className={styles.composerModelRunMenuHelpTip}>{hint}</span>}
        side="top"
        align="end"
      >
        <span className={styles.composerModelRunMenuHelp} aria-label={hint}>
          <QuestionIcon size={12} weight="bold" />
        </span>
      </BubbleTooltip>
    </div>
  )
}

function ComposerModelRunSelectorImpl({
  t,
  modelSelector,
  modelRunSummary,
  reasoning,
  runProfile,
  thinkingDepth,
  thinkingVisibility,
  pureChat,
  capabilityControls = [],
  density = 'default',
}: ComposerModelRunSelectorProps): ReactElement {
  const composerPort = useConversationComposerPort()
  const [open, setOpen] = useState(false)
  const [activeProvider, setActiveProvider] = useState<Nullable<string>>(null)
  const isCompact = density === 'compact'
  const selectedProvider = useMemo(
    () =>
      toNullable(
        modelSelector?.providers.find((option) => option.value === modelSelector.provider)
      ),
    [modelSelector?.provider, modelSelector?.providers]
  )
  const fallbackProvider = toNullable(modelSelector?.providers[0])
  const visibleProvider = selectedProvider ?? fallbackProvider
  const activeProviderOption = toNullable(
    modelSelector?.providers.find((option) => option.value === activeProvider)
  )
  const visibleModel =
    visibleProvider && modelSelector
      ? resolveVisibleProviderModel(visibleProvider, visibleProvider, modelSelector.model)
      : ''
  const selectedModelLabel = modelSelector
    ? getSelectedModelLabel(visibleProvider, visibleModel)
    : t('chat.selectModel')
  // 宿主给的摘要优先，且**两格一起接管**：没有模型目录时包内回落的「选择模型」是一句做不到的
  // 承诺（用户点开是空菜单），而两格各自回落时，宿主根本无从表达「这两个轴现在是同一件事」——
  // 真机上模型格与推理档格双双处于「跟随引擎设置」，包内各画各的，按钮就渲染成
  // 「Codex / 跟随 Codex 设置」紧跟「跟随 Codex 设置」，同一句话连出现两次。
  const selectedModelDisplayLabel =
    modelRunSummary?.primaryLabel ??
    (modelSelector && visibleProvider
      ? `${visibleProvider.label} / ${selectedModelLabel}`
      : selectedModelLabel)
  const visibleRunProfileValue =
    runProfile?.value === 'expanded' && !composerPort.experimentalFeaturesEnabled
      ? 'balanced'
      : runProfile?.value
  const visibleRunProfileOptions = composerPort.experimentalFeaturesEnabled
    ? RunProfileOptions
    : RunProfileOptions.filter((option) => option.value !== 'expanded')
  const selectedReasoningLabel =
    reasoning?.summaryLabel ??
    reasoning?.options.find((option) => option.value === reasoning.value)?.label
  // 运行档那一格：宿主给了摘要就整格听它的（**包括「这一格什么都不用说」**——`secondaryLabel`
  // 缺席时不渲染，而不是回落到 Velar 的「自动」，那是外部执行体根本没有的概念）。
  const selectedRunProfileLabel = runProfile
    ? t(
        visibleRunProfileOptions.find((option) => option.value === visibleRunProfileValue)
          ?.labelKey ?? 'chat.composerRunProfile_auto'
      )
    : modelRunSummary
      ? modelRunSummary.secondaryLabel
      : (selectedReasoningLabel ?? t('chat.composerRunProfile_auto'))
  const modelMenuCapabilityControls = capabilityControls.filter(
    (control) => control.placement === 'model-menu'
  )
  const disabled =
    (!modelSelector || modelSelector.disabled || isEmpty(modelSelector.providers)) &&
    (!runProfile || runProfile.disabled) &&
    (!reasoning || reasoning.disabled) &&
    (!thinkingDepth || thinkingDepth.disabled) &&
    (!thinkingVisibility || thinkingVisibility.disabled) &&
    (!pureChat || pureChat.disabled) &&
    (isEmpty(modelMenuCapabilityControls) ||
      modelMenuCapabilityControls.every((control) => control.disabled))
  const handleOpenChange = useCallback((nextOpen: boolean): void => {
    setOpen(nextOpen)
    if (!nextOpen) setActiveProvider(null)
    else dispatchOnboardingComposerModelMenuOpened()
  }, [])

  useEffect(() => {
    const closeMenu = (): void => handleOpenChange(false)
    window.addEventListener(OnboardingCloseComposerMenusEventName, closeMenu)
    return () => window.removeEventListener(OnboardingCloseComposerMenusEventName, closeMenu)
  }, [handleOpenChange])

  return (
    <BusinessCascadingMenu
      open={open}
      onOpenChange={handleOpenChange}
      activeSubmenuId={activeProvider}
      onActiveSubmenuChange={setActiveProvider}
      onCloseSubmenus={() => setActiveProvider(null)}
      side="top"
      align="end"
      sideOffset={8}
      widthStrategy="content"
      className={cn(
        styles.composerModelRunMenuContent,
        isCompact && styles.composerModelRunMenuContentCompact
      )}
      anchor={({ getAnchorProps }) => (
        <Button
          variant="ghost"
          size="sm"
          {...getAnchorProps<HTMLButtonElement>({ disabled })}
          disabled={disabled}
          className={styles.composerModelRunSelectorButton}
          data-tour-id="chat-model-run-controls"
          data-open={open}
          title={
            selectedRunProfileLabel
              ? `${selectedModelDisplayLabel} / ${selectedRunProfileLabel}`
              : selectedModelDisplayLabel
          }
        >
          <Text tone="strong" truncate className={styles.composerModelRunSelectorModelLabel}>
            {selectedModelDisplayLabel}
          </Text>
          {!!selectedRunProfileLabel && (
            <Text tone="caption" truncate className={styles.composerModelRunSelectorRunLabel}>
              {selectedRunProfileLabel}
            </Text>
          )}
          <CaretDownIcon size={12} />
        </Button>
      )}
    >
      {(menu) => (
        <>
          <div
            {...(menu.getPrimaryPanelProps({
              role: 'menu',
              className: cn(
                styles.composerModelRunMenuPrimary,
                isCompact && styles.composerModelRunMenuPrimaryCompact
              ),
              // getPrimaryPanelProps 内部消费 placementLevel 转成 data-attr、运行态不回传；其返回类型
              // 在 dist 声明发射中过宽（泄漏 placementLevel），此处 cast 收窄到 DOM 属性，行为不变。
            }) as HTMLAttributes<HTMLDivElement>)}
            data-tour-id="chat-model-run-menu"
            data-tour-include-menu-panels="true"
          >
            {!!runProfile && (
              <MenuSectionHeader
                label={t('chat.composerRunProfile')}
                hint={t('chat.composerRunProfileHint')}
              />
            )}
            <ComposerCapabilityControls
              controls={capabilityControls}
              placement="model-menu"
              disabled={disabled}
            />
            {!!runProfile && (
              <div className={styles.composerModelRunMenuSegment}>
                <ComposerTierSlider
                  value={visibleRunProfileValue ?? 'auto'}
                  options={visibleRunProfileOptions.map((option) => ({
                    value: option.value,
                    label: t(option.labelKey),
                  }))}
                  onChange={runProfile.onChange}
                  disabled={runProfile.disabled}
                  ariaLabel={t('chat.composerRunProfile')}
                />
              </div>
            )}

            {!!reasoning && <MenuSectionHeader label={reasoning.label} hint={reasoning.hint} />}
            {!!reasoning && (
              <div className={styles.composerModelRunMenuSegment}>
                <ComposerTierSlider
                  value={reasoning.value}
                  options={reasoning.options}
                  onChange={reasoning.onChange}
                  disabled={reasoning.disabled}
                  ariaLabel={reasoning.label}
                />
              </div>
            )}

            {!!thinkingDepth && (
              <MenuSectionHeader
                label={t('chat.composerThinkingDepth')}
                hint={t('chat.composerThinkingDepthHint')}
              />
            )}
            {!!thinkingDepth && (
              <div className={styles.composerModelRunMenuSegment}>
                <ComposerTierSlider
                  value={thinkingDepth.value}
                  options={(thinkingVisibility
                    ? ThinkingDepthOptions
                    : LegacyThinkingDepthOptions
                  ).map((option) => ({
                    value: option.value,
                    label: t(option.labelKey),
                  }))}
                  onChange={thinkingDepth.onChange}
                  disabled={thinkingDepth.disabled}
                  ariaLabel={t('chat.composerThinkingDepth')}
                />
              </div>
            )}

            {!!modelSelector &&
              // 段头文案与说明气泡都由控件自报（外部执行体的目录来源要说清楚是谁给的）；
              // 只在宿主没给说明时退回包内的纯段头，不替它编一句「模型来自哪里」。
              (modelSelector.hint ? (
                <MenuSectionHeader
                  label={modelSelector.label || t('chat.composerModelSection')}
                  hint={modelSelector.hint}
                />
              ) : (
                <Text className={styles.composerModelRunMenuHeader}>
                  {modelSelector.label || t('chat.composerModelSection')}
                </Text>
              ))}

            {modelSelector
              ? modelSelector.providers.map((providerOption) => {
                  const modelLabel = getProviderModelDisplayLabel(
                    providerOption,
                    visibleProvider,
                    modelSelector.model
                  )
                  const selected = providerOption.value === visibleProvider?.value

                  return (
                    <BusinessCascadingMenuItem
                      key={providerOption.value}
                      menu={menu}
                      submenuId={providerOption.value}
                      selected={selected}
                      label={`${providerOption.label} / ${modelLabel}`}
                      title={
                        providerOption.description || `${providerOption.label} / ${modelLabel}`
                      }
                      disabled={modelSelector.disabled || isEmpty(providerOption.models)}
                      trailing={<CaretRightIcon size={12} className={menu.classes.disclosure} />}
                    />
                  )
                })
              : null}

            {!!pureChat && (
              <BusinessCascadingMenuItem
                menu={menu}
                interaction="leaf"
                selected={pureChat.value}
                showSelectedIndicator={false}
                label={t('chat.composerPureChatMode')}
                disabled={pureChat.disabled}
                onClick={() => pureChat.onChange(!pureChat.value)}
                trailing={
                  <Switch
                    size="xs"
                    checked={pureChat.value}
                    disabled={pureChat.disabled}
                    className={styles.composerMenuSwitch}
                    onClick={(event) => event.stopPropagation()}
                    onCheckedChange={pureChat.onChange}
                  />
                }
              />
            )}

            {!!thinkingVisibility && (
              <BusinessCascadingMenuItem
                menu={menu}
                interaction="leaf"
                selected={thinkingVisibility.value}
                showSelectedIndicator={false}
                label={t('chat.composerThinkingVisibility')}
                disabled={thinkingVisibility.disabled}
                onClick={() => thinkingVisibility.onChange(!thinkingVisibility.value)}
                trailing={
                  <Switch
                    size="xs"
                    checked={thinkingVisibility.value}
                    disabled={thinkingVisibility.disabled}
                    className={styles.composerMenuSwitch}
                    onClick={(event) => event.stopPropagation()}
                    onCheckedChange={thinkingVisibility.onChange}
                  />
                }
              />
            )}
          </div>

          {!!(modelSelector && activeProviderOption) && (
            <BusinessCascadingSubmenuSection
              menu={menu}
              header={<Text tone="caption">{activeProviderOption.label}</Text>}
              submenuWidth={isCompact ? '13rem' : '16rem'}
            >
              {activeProviderOption.models.map((option: ModelSelectOption) => {
                const activeProviderVisibleModel = resolveVisibleProviderModel(
                  activeProviderOption,
                  visibleProvider,
                  modelSelector.model
                )
                const selected =
                  activeProviderOption.value === visibleProvider?.value &&
                  option.value === activeProviderVisibleModel

                return (
                  <BusinessCascadingMenuItem
                    key={option.value}
                    menu={menu}
                    selected={selected}
                    disabled={option.disabled}
                    title={option.description || option.label}
                    trailing={
                      option.meta ? (
                        <Text tone="caption" className={styles.composerModelMenuItemMeta}>
                          {option.meta}
                        </Text>
                      ) : undefined
                    }
                    onClick={() => {
                      modelSelector.onChange(activeProviderOption.value, option.value)
                      menu.close()
                    }}
                  >
                    <Text className={menu.classes.itemLabel}>{option.label}</Text>
                  </BusinessCascadingMenuItem>
                )
              })}
            </BusinessCascadingSubmenuSection>
          )}
        </>
      )}
    </BusinessCascadingMenu>
  )
}

export const ComposerModelRunSelector = memo(ComposerModelRunSelectorImpl)
ComposerModelRunSelector.displayName = 'ComposerModelRunSelector'
