import { type ClassValue, clsx } from 'clsx'

/** 合并类名（组件库 `.velar-*` 专用；不解析 Tailwind 工具类冲突）。 */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs)
}
