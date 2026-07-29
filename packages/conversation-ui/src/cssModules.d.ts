/**
 * CSS Modules 环境声明——包由 tsc 独立类型检查（不含 vite/client），需自持 `*.module.css` 类型。
 * 与 vite/client 的声明同形，渲染进程构建时由 Vite 处理真实样式。
 */
declare module '*.module.css' {
  const classes: { readonly [key: string]: string }
  export default classes
}
