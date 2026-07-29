import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

import { cn as uiCn } from './cn'

export const StyleUtils = {
  /**
   * Tailwind 工具类合并（renderer CSS Modules 用 twMerge；组件库 `.velar-*` 用 uiCn）。
   */
  cn: (...inputs: ClassValue[]): string => twMerge(clsx(inputs)),

  /** 组件库全局类名合并（无 Tailwind 冲突消解）。 */
  uiCn,

  /**
   * CSS 模块类名拼接，过滤假值后空格连接。
   */
  cx: (...classes: Array<string | false | undefined>): string =>
    classes.filter((value) => !!value).join(' '),

  bindCx: <T extends Record<string, string>>(styles: T) =>
    (...keys: Array<keyof T | false | undefined>): string =>
      keys.filter((value) => !!value).map((k) => styles[k as keyof T] ?? '').filter((value) => !!value).join(' '),
}
