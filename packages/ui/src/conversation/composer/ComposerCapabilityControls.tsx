import { type ReactElement } from 'react'
import {
  CaretRightIcon,
  FlaskIcon,
  GlobeSimpleIcon,
  ImageIcon,
  MagnifyingGlassIcon,
  PaperclipIcon,
  SparkleIcon,
} from '@phosphor-icons/react'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { Select } from '@velaros-ai/ui/primitives/forms/Select'
import {
  BusinessCascadingMenuItem,
  type BusinessCascadingMenuRenderProps,
  BusinessCascadingSubmenuSection,
} from '@velaros-ai/ui/product/menus/BusinessCascadingMenu'

import { ComposerMenuItemBody, ComposerMenuSwitchIndicator } from './addMenu/ComposerMenuItemChrome'

import styles from './ChatInput.module.css'

import { isEmpty, isString, isTrue, optionalWhen, toNullable } from '#internal/runtime'

export type ChatComposerCapabilityControlKind = 'toggle' | 'choice' | 'action'
export type ChatComposerCapabilityPlacement = 'add-menu' | 'toolbar' | 'model-menu'

export interface ChatComposerCapabilityChoice {
  id: string
  label: string
  description?: string
  /**
   * 这一档要不要按危险画（红字）。**宿主声明，包内不猜**：哪一档危险是宿主/引擎才知道的事实
   * （外部引擎的「完全访问」= 撤沙箱 + 不询问），组件库按名字猜就是抄一份会腐的闭集。
   */
  tone?: 'danger'
}

/**
 * Composer 自身的能力控件协议。
 *
 * 它只描述渲染与交互，不知道能力来自网页厂商、本地模型还是未来插件。
 */
export interface ChatComposerCapabilityControl {
  id: string
  kind: ChatComposerCapabilityControlKind
  placement: ChatComposerCapabilityPlacement
  label: string
  description?: string
  icon?: string
  disabled?: boolean
  capability?: string
  value?: boolean | string
  choices?: ChatComposerCapabilityChoice[]
  onChange?: (value: boolean | string) => void
  onAction?: () => void | Promise<void>
}

interface ComposerCapabilityControlsProps {
  controls: readonly ChatComposerCapabilityControl[]
  placement: Exclude<ChatComposerCapabilityPlacement, 'add-menu'>
  disabled?: boolean
}

interface ComposerCapabilityMenuItemsProps {
  controls: readonly ChatComposerCapabilityControl[]
  menu: BusinessCascadingMenuRenderProps
  disabled?: boolean
}

export function ComposerCapabilityIcon({
  name,
  size = 14,
}: {
  name?: string
  size?: number
}): ReactElement {
  const normalized = name?.trim().toLowerCase()
  if (normalized === 'search') return <MagnifyingGlassIcon size={size} />
  if (normalized === 'web') return <GlobeSimpleIcon size={size} />
  if (normalized === 'image') return <ImageIcon size={size} />
  if (normalized === 'file' || normalized === 'attachment') return <PaperclipIcon size={size} />
  if (normalized === 'research') return <FlaskIcon size={size} />
  return <SparkleIcon size={size} />
}

function updateCapabilityControl(control: ChatComposerCapabilityControl, active: boolean): void {
  if (control.kind === 'toggle') control.onChange?.(!active)
  else void control.onAction?.()
}

/** 当前选中的那一档（`value` 不是字符串 / 不在清单里 ⇒ 没有选中项）。 */
function selectedCapabilityChoice(
  control: ChatComposerCapabilityControl
): Nullable<ChatComposerCapabilityChoice> {
  return toNullable(
    (control.choices ?? []).find(
      (choice) => isString(control.value) && choice.id === control.value
    )
  )
}

/**
 * 闭集档在**级联菜单里**的子菜单 id。
 *
 * 与模型格的 provider id 共用同一个 `activeSubmenuId` 命名空间，所以带前缀：控件 id 是引擎声明的
 * 自由字符串（`approval` / `personality` …），不加前缀迟早与某个 provider id 撞车，撞上的表现是
 * 「点审批档弹出模型清单」。
 */
export function composerCapabilityChoiceSubmenuId(controlId: string): string {
  return `capability-choice:${controlId}`
}

/** 当前展开的子菜单是哪一格闭集档（不是闭集档就返回 null，此时该渲染的是别的子菜单）。 */
export function findComposerCapabilityChoiceBySubmenuId(
  controls: readonly ChatComposerCapabilityControl[],
  submenuId: Nullable<string>
): Nullable<ChatComposerCapabilityControl> {
  if (!submenuId) return null
  return toNullable(
    controls.find(
      (control) =>
        control.kind === 'choice' && composerCapabilityChoiceSubmenuId(control.id) === submenuId
    )
  )
}

/**
 * 闭集档的**菜单形态**：一行菜单项（标题 + 当前档 + 展开箭头），点开是一层子菜单。
 *
 * 判决（2026-08-07）：上一版这一格是**原生 `<select>`**——同一个面板里模型格是级联菜单项、
 * 推理档是滑杆，只有它是操作系统画的下拉框（自带边框、自带箭头、深浅色跟不上主题、选项正文
 * 只能挤进原生 `title`）。它与旁边任何一格都不像同一个产品。现在走与模型格**同一个组件**，
 * 逐档正文因此能如实渲染出来——审批档的「未预批准即拒」与「越界即失败」是安全语义，
 * 一个 label 撑不起它们的差别。
 */
function CapabilityChoiceMenuTrigger({
  control,
  disabled,
  menu,
}: {
  control: ChatComposerCapabilityControl
  disabled: boolean
  menu: BusinessCascadingMenuRenderProps
}): ReactElement {
  const selectedChoice = selectedCapabilityChoice(control)
  return (
    <BusinessCascadingMenuItem
      menu={menu}
      submenuId={composerCapabilityChoiceSubmenuId(control.id)}
      title={selectedChoice?.description || control.description || control.label}
      disabled={disabled || isEmpty(control.choices ?? [])}
      trailing={
        <span className={styles.composerCapabilityChoiceTrailing}>
          <Text
            tone="caption"
            truncate
            className={styles.composerCapabilityChoiceValue}
            data-tone={selectedChoice?.tone}
          >
            {selectedChoice?.label ?? ''}
          </Text>
          <CaretRightIcon size={12} className={menu.classes.disclosure} />
        </span>
      }
    >
      {/* 不给帮助图标：这一行右边已经写着当前档，展开的子菜单里逐档都有正文。标题旁再挂一个
          问号，是把「点开看」这件事说了两遍。控件自述仍留在行的原生 title 上。 */}
      <ComposerMenuItemBody label={control.label} />
    </BusinessCascadingMenuItem>
  )
}

/** 闭集档的子菜单面板：逐档一行，正文如实渲染（安全档的差别就写在正文里）。 */
export function ComposerCapabilityChoiceSubmenu({
  control,
  menu,
  disabled = false,
  submenuWidth = '17rem',
}: {
  control: ChatComposerCapabilityControl
  menu: BusinessCascadingMenuRenderProps
  disabled?: boolean
  submenuWidth?: string
}): ReactElement {
  return (
    <BusinessCascadingSubmenuSection
      menu={menu}
      header={<Text tone="caption">{control.label}</Text>}
      submenuWidth={submenuWidth}
    >
      {(control.choices ?? []).map((choice) => (
        <BusinessCascadingMenuItem
          key={choice.id}
          menu={menu}
          selected={isString(control.value) && choice.id === control.value}
          disabled={disabled}
          title={choice.description || choice.label}
          data-tone={choice.tone}
          className={choice.tone === 'danger' ? styles.composerCapabilityChoiceDangerItem : undefined}
          onClick={() => {
            control.onChange?.(choice.id)
            menu.close()
          }}
        >
          <ComposerMenuItemBody label={choice.label} help={choice.description} />
        </BusinessCascadingMenuItem>
      ))}
    </BusinessCascadingSubmenuSection>
  )
}

/** 闭集档的**菜单外形态**（工具条 / 没有级联菜单可用的宿主）：走设计系统的下拉，不用原生控件。 */
function CapabilityChoiceControl({
  control,
  disabled,
  inMenu,
}: {
  control: ChatComposerCapabilityControl
  disabled: boolean
  inMenu: boolean
}): ReactElement {
  const selectedChoice = selectedCapabilityChoice(control)
  return (
    <span
      className={inMenu ? styles.providerCapabilityMenuChoice : styles.providerCapabilityChoice}
      title={selectedChoice?.description || control.description || control.label}
    >
      <span>{control.label}</span>
      <Select
        variant="bare"
        size="xs"
        value={optionalWhen(isString, control.value)}
        disabled={disabled}
        options={(control.choices ?? []).map((choice) => ({
          value: choice.id,
          label: choice.label,
          description: choice.description,
          // Select 原语自带 danger 色调，直接透传（两处对「危险档长什么样」不各画一套）。
          tone: choice.tone,
        }))}
        onChange={(next) => control.onChange?.(next)}
      />
    </span>
  )
}

function ToolbarCapabilityControl({
  control,
  disabled,
}: {
  control: ChatComposerCapabilityControl
  disabled: boolean
}): ReactElement {
  const active = control.kind === 'toggle' && isTrue(control.value)
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={styles.providerCapabilityButton}
      data-active={active}
      aria-pressed={control.kind === 'toggle' ? active : undefined}
      title={control.description || control.label}
      disabled={disabled}
      onClick={() => updateCapabilityControl(control, active)}
    >
      <ComposerCapabilityIcon name={control.icon} />
      <span>{control.label}</span>
    </Button>
  )
}

/**
 * 闭集档在级联菜单里的一组触发行。**只画 `kind: 'choice'` 的格子**，别的形态照旧走各自的渲染
 * （宿主把两拨分开传；混在一起画会让开关与下拉共用同一层布局）。
 *
 * 展开后的面板由宿主渲染 —— 级联菜单的子菜单是**单开**的（`activeSubmenuId` 一格），面板与
 * 模型格的 provider 面板是同一个位置的竞争者，只有宿主知道现在该画哪一个。
 */
export function ComposerCapabilityChoiceMenuItems({
  controls,
  menu,
  disabled = false,
}: ComposerCapabilityMenuItemsProps): Nullable<ReactElement> {
  const choices = controls.filter((control) => control.kind === 'choice')
  if (isEmpty(choices)) return null
  return (
    <>
      {choices.map((control) => (
        <CapabilityChoiceMenuTrigger
          key={control.id}
          control={control}
          menu={menu}
          disabled={disabled || !!control.disabled}
        />
      ))}
    </>
  )
}

export function ComposerCapabilityMenuItems({
  controls,
  menu,
  disabled = false,
}: ComposerCapabilityMenuItemsProps): Nullable<ReactElement> {
  if (isEmpty(controls)) return null
  return (
    <>
      {controls.map((control) => {
        const isDisabled = disabled || !!control.disabled
        if (control.kind === 'choice')
          return (
            <CapabilityChoiceControl
              key={control.id}
              control={control}
              disabled={isDisabled}
              inMenu
            />
          )
        const active = control.kind === 'toggle' && isTrue(control.value)
        return (
          <BusinessCascadingMenuItem
            key={control.id}
            menu={menu}
            interaction="leaf"
            icon={<ComposerCapabilityIcon name={control.icon} />}
            title={control.description || control.label}
            selected={active}
            showSelectedIndicator={false}
            disabled={isDisabled}
            onClick={() => updateCapabilityControl(control, active)}
            trailing={
              control.kind === 'toggle' ? (
                <ComposerMenuSwitchIndicator checked={active} />
              ) : undefined
            }
          >
            <ComposerMenuItemBody label={control.label} help={control.description} />
          </BusinessCascadingMenuItem>
        )
      })}
    </>
  )
}

export function ComposerCapabilityControls({
  controls,
  placement,
  disabled = false,
}: ComposerCapabilityControlsProps): Nullable<ReactElement> {
  const visible = controls.filter((control) => control.placement === placement)
  if (isEmpty(visible)) return null
  return (
    <div className={styles.providerCapabilityToolbar} data-capability-placement={placement}>
      {visible.map((control) => {
        const isDisabled = disabled || !!control.disabled
        return control.kind === 'choice' ? (
          <CapabilityChoiceControl
            key={control.id}
            control={control}
            disabled={isDisabled}
            inMenu={false}
          />
        ) : (
          <ToolbarCapabilityControl key={control.id} control={control} disabled={isDisabled} />
        )
      })}
    </div>
  )
}
