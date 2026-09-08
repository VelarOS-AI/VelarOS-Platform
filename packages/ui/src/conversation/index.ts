/**
 * `@velaros-ai/ui/conversation` 是聊天渲染门面包。
 *
 * 本包提供消息块管线、工具卡、流式起搏和宿主能力注入端口。基础卡片与原语仍由
 * `@velaros-ai/ui` 提供；本包不直接依赖渲染器进程通信或路由，国际化、动作和渲染插槽等宿主能力
 * 均通过端口反向注入。
 *
 * 对外只暴露约定分区，流式、国际化、工具渲染、卡片、消息块和会话壳等内部原子禁止深路径依赖。
 */
export * from './blocks'
export * from './cards'
export * from './i18n'
export * from './projection'
export * from './react-hooks/chatScrollNavigatorVisibility'
export * from './react-hooks/scrollBehavior'
export * from './react-hooks/useScrollToBottom'
export * from './render-slots'
export * from './shell'
export * from './status'
export * from './stream'
export * from './tool-render'
