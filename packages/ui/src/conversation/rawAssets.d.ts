/**
 * `?raw` 资源导入环境声明——包由 tsc 独立类型检查（不含 vite/client），需自持 `*?raw` 类型。
 * 渲染进程构建时由 Vite 处理为字符串。
 */
declare module '*?raw' {
  const content: string
  export default content
}
