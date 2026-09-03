/**
 * 保留旧同视图导航 bridge 的兼容入口。
 *
 * 新窗口请求现在只由 Electron 主进程的 `setWindowOpenHandler` 裁决。页面侧不能在 capture
 * 阶段接管链接：那会抢在站点自己的 click/SPA handler 之前执行，令占位 `href="#"` 等链接
 * 丢失真正的导航逻辑。旧入口仍返回一个无副作用脚本，避免已发布调用方在升级时断裂。
 */
function buildSameViewNavigationBridgeScript(): string {
  return 'true'
}

export { buildSameViewNavigationBridgeScript }
