import { ArrowRightIcon } from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import { StyleUtils } from '@velaros-ai/ui'
import { Text } from '@velaros-ai/ui/primitives/display/Text'

import styles from './ComposerNextStepSuggestionMenu.module.css'

import type { ChatSuggestionItem } from '#contracts'
import { isEmpty } from '#internal/runtime'

const cx = StyleUtils.bindCx(styles)

interface ComposerNextStepSuggestionMenuProps {
  suggestions: ChatSuggestionItem[]
  selectedId?: LooseOptional<string>
  onSelect?: (suggestion: ChatSuggestionItem) => void
  label: string
  disabled?: boolean
}

/** 单轮结束后在 composer 扩展层展示，和 `/` Skill、`@` 评论面板占用同一位置。 */
export function ComposerNextStepSuggestionMenu({
  suggestions,
  selectedId,
  onSelect,
  label,
  disabled = false,
}: ComposerNextStepSuggestionMenuProps): Nullable<ReactElement> {
  if (isEmpty(suggestions) || !onSelect) return null

  return (
    <div className={styles.panel} role="listbox" aria-label={label}>
      <div className={styles.list}>
        {suggestions.map((suggestion) => {
          const selected = suggestion.id === selectedId
          return (
            <button
              key={suggestion.id}
              type="button"
              role="option"
              aria-selected={selected}
              className={cx('item', selected && 'itemSelected')}
              disabled={disabled}
              onMouseDown={(event) => {
                // 保持 textarea 焦点；点击建议行会直接发送该提示词。
                event.preventDefault()
              }}
              onClick={() => onSelect(suggestion)}
            >
              <Text className={styles.itemPrompt}>{suggestion.prompt}</Text>
              <ArrowRightIcon className={styles.itemArrow} size={14} aria-hidden />
            </button>
          )
        })}
      </div>
    </div>
  )
}
