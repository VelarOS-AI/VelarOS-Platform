/**
 * 常量表：项目空间的身份。不 import 任何东西，浏览器和渲染进程都能用（从 `@velaros-ai/project/contracts` 取）。
 * 两件项目工具的上限、错误原因与内核缺省策略在 `@velaros-ai/velar/project/contracts`。
 */

/** 项目空间自己的身份，宿主按它挂载这个空间。 */
export const ProjectSpaceId = 'project' as const
