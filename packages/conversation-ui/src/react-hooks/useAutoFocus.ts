import { useMount } from 'ahooks'
import type { RefObject } from 'react'

export function useAutoFocus<T extends HTMLElement>(ref: RefObject<Nullable<T>>): void {
  useMount(() => { ref.current?.focus() })
}
