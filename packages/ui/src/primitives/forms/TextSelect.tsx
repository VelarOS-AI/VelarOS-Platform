/**
 * 文本样式的轻量下拉（无边框选择）。
 *
 * 样式：`.velar-text-select-root` · 见 styles/components/。
 */
import {
  type FocusEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { CaretDownIcon } from '@phosphor-icons/react'

import { cn } from '../../lib/cn'
import { isEmpty } from '../../lib/runtime'

import { Input } from './Input'

export interface TextSelectOption {
  value: string
  label: string
}

export interface TextSelectProps {
  className?: string
  label: string
  placeholder?: string
  value: string
  options: TextSelectOption[]
  disabled?: boolean
  loading: boolean
  onOpen?: () => void
  onChange: (value: string) => void
  onCommit: (value?: string) => void
}

export function TextSelect({
  className,
  label,
  placeholder,
  value,
  options,
  disabled,
  loading,
  onOpen,
  onChange,
  onCommit,
}: TextSelectProps): ReactElement {
  const inputWrapRef = useRef<HTMLDivElement>(null)
  const menuOpenRef = useRef(false)
  const listboxId = useId()
  const [menuOpen, setMenuOpen] = useState(false)
  const shouldShowMenu = !disabled && menuOpen && (loading || !isEmpty(options))
  const closeMenu = useCallback((): void => {
    menuOpenRef.current = false
    setMenuOpen(false)
  }, [])
  const openMenu = useCallback((): void => {
    if (disabled) return

    if (!menuOpenRef.current) {
      onOpen?.()
    }
    menuOpenRef.current = true
    setMenuOpen(true)
  }, [disabled, onOpen])
  const handleInputBlur = useCallback(
    (event: FocusEvent<HTMLInputElement>): void => {
      const relatedTarget = event.relatedTarget
      if (relatedTarget instanceof Node && inputWrapRef.current?.contains(relatedTarget)) return

      closeMenu()
      onCommit(event.currentTarget.value)
    },
    [closeMenu, onCommit]
  )
  const handleOptionSelect = useCallback(
    (nextValue: string): void => {
      onChange(nextValue)
      onCommit(nextValue)
      closeMenu()
    },
    [closeMenu, onChange, onCommit]
  )

  useEffect(() => {
    if (disabled) closeMenu()
  }, [closeMenu, disabled])

  return (
    <div
      ref={inputWrapRef}
      data-slot="text-select"
      className={cn('velar-text-select-root', className)}
    >
      <Input
        className="velar-text-select-input"
        size="sm"
        value={value}
        placeholder={placeholder ?? label}
        disabled={disabled}
        role="combobox"
        aria-label={label}
        aria-busy={loading}
        aria-controls={listboxId}
        aria-expanded={!disabled && menuOpen}
        aria-haspopup="listbox"
        aria-autocomplete="list"
        data-state={!disabled && menuOpen ? 'open' : 'closed'}
        onFocus={() => openMenu()}
        onClick={() => openMenu()}
        onChange={(event) => {
          openMenu()
          onChange(event.target.value)
        }}
        onBlur={handleInputBlur}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            openMenu()
            return
          }

          if (event.key === 'Escape') {
            closeMenu()
            event.currentTarget.blur()
            return
          }

          if (event.key !== 'Enter') return

          onCommit(event.currentTarget.value)
          closeMenu()
          event.currentTarget.blur()
        }}
      />
      <CaretDownIcon className="velar-text-select-caret" size={16} aria-hidden="true" />
      {shouldShowMenu && (
        <div id={listboxId} className="velar-text-select-menu" role="listbox" aria-label={label}>
          <div className="velar-text-select-menu-inner">
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                className="velar-text-select-option"
                role="option"
                aria-selected={option.value === value}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => handleOptionSelect(option.value)}
              >
                <span className="velar-text-select-option-label">{option.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
