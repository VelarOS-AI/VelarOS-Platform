/** 标准库只转发挂载模块；每个操作的参数声明仍由 Kernel 的 schema 生成。 */
export const VelarosStandardDeclarations = `declare module 'velaros' {
  export interface OutputView { mode?: 'auto'|'full'|'reference'|'summary'; maxChars?: number; lines?: readonly [number,number]; maxItems?: number; edge?: 'head'|'tail'; paths?: readonly string[]; }
  export interface OutputOptions { key?: string; purpose?: string; type?: 'text'|'code'|'json'|'list'|'image'|'file'; language?: string; priority?: 'high'|'normal'|'low'; required?: boolean; view?: OutputView; }
  export function output(value: unknown, options?: OutputOptions): void;
  export namespace output { function configure(config: {maxChars?: number}): void; }
}`
