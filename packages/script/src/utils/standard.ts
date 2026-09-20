/** 标准库只转发挂载模块；每个操作的参数声明仍由 Kernel 的 schema 生成。 */
export const VelarosStandardDeclarations = `declare module 'velaros' {
  export * as modules from 'velaros:modules';
  export * as execution from 'velaros:execution';
  export * as artifacts from 'velaros:artifacts';
  export * as programs from 'velaros:programs';
  export * as results from 'velaros:results';
  export function output(value: unknown): void;
}`
