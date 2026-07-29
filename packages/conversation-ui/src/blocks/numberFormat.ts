/**
 * 数字格式化原语（会话渲染件消费面）。宿主 `@utils/format/numberFormat.utils` 是多域（调试 / 用量
 * 指示器 / 令牌页）共用面，随壳退场；本处复制会话渲染件实际用到的子集（`formatExactNumber`），
 * 避免把非会话消费者耦合进本包（§12 门面收口，镜像 cards 原子的子集复制先例）。
 */
export function formatExactNumber(locale: string, value: number): string {
  return new Intl.NumberFormat(locale).format(value)
}
