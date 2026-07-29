import { type ReactElement } from 'react'
import {
  FlaskIcon,
  GlobeSimpleIcon,
  ImageIcon,
  MagnifyingGlassIcon,
  PaperclipIcon,
  SparkleIcon,
} from '@phosphor-icons/react'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import {
  BusinessCascadingMenuItem,
  type BusinessCascadingMenuRenderProps,
} from '@velaros-ai/ui/product/menus/BusinessCascadingMenu'

import { ComposerMenuItemBody, ComposerMenuSwitchIndicator } from './addMenu/ComposerMenuItemChrome'

import styles from './ChatInput.module.css'

import { isEmpty,isString, isTrue } from '#internal/runtime'

export type ChatComposerCapabilityControlKind = 'toggle' | 'choice' | 'action'
export type ChatComposerCapabilityPlacement = 'add-menu' | 'toolbar' | 'model-menu'

export interface ChatComposerCapabilityChoice {
  id: string
  label: string
  description?: string
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

function CapabilityChoiceControl({
  control,
  disabled,
  inMenu,
}: {
  control: ChatComposerCapabilityControl
  disabled: boolean
  inMenu: boolean
}): ReactElement {
  return (
    <label
      className={inMenu ? styles.providerCapabilityMenuChoice : styles.providerCapabilityChoice}
      title={control.description || control.label}
    >
      <span>{control.label}</span>
      <select
        aria-label={control.label}
        value={isString(control.value) ? control.value : ''}
        disabled={disabled}
        onChange={(event) => control.onChange?.(event.target.value)}
      >
        {(control.choices ?? []).map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.label}
          </option>
        ))}
      </select>
    </label>
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
