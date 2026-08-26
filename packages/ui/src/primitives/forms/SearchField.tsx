/**
 * 统一搜索框。
 *
 * 搜索图标、透明输入层和整框聚焦态由组件自身持有，消费方只负责尺寸与布局。
 */
import React, { forwardRef, memo } from 'react'
import { MagnifyingGlassIcon } from '@phosphor-icons/react'

import { Input, type InputProps } from './Input'

export interface SearchFieldProps
  extends Omit<InputProps, 'type' | 'variant' | 'className'> {}

export const SearchField = memo(
  forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
    {
      disabled,
      size = 'sm',
      ...props
    },
    ref
  ): React.ReactElement {
    return (
      <div
        data-slot="search-field"
        data-size={size}
        data-disabled={disabled || undefined}
        className="velar-search-field"
      >
        <MagnifyingGlassIcon className="velar-search-field-icon" size={14} aria-hidden="true" />
        <Input
          {...props}
          ref={ref}
          type="search"
          variant="ghost"
          size={size}
          disabled={disabled}
          className="velar-search-field-input"
        />
      </div>
    )
  })
)

SearchField.displayName = 'SearchField'
