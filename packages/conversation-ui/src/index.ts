/**
 * @velaros-ai/conversation-ui — 聊天渲染门面包。
 *
 * 用户新 UI 的会话渲染件：消息块管线、工具卡族、流式起搏、以及宿主能力注入端口。
 * 底座（CardKit / ActionCard / 原语）留在 @velaros-ai/ui，本包消费之；本包零 rendererIpc、
 * 零 react-router——宿主能力一律经注入端口（i18n / action / render-slot）反转进来。
 *
 * 门面收口：对外只暴露少数分区（`.` / `./stream` / `./i18n`），内部原子（stream / i18n /
 * 后续的 tool-render / cards / blocks / shell）是实现细节，外部禁直依内部深路径。
 */
export * from './blocks'
export * from './cards'
export * from './i18n'
export * from './projection'
export * from './render-slots'
export * from './shell'
export * from './status'
export * from './stream'
export * from './tool-render'
