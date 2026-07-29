/**
 * `SystemToolInstallSuggestionView` — system-tool-install 建议卡消费的 **viewmodel 输出投影**。
 *
 * 安装动作触达 `rendererIpc.settings.installSystemTool` + 全局提示，住宿主 hook
 * `useSystemToolInstallSuggestionViewModel`；包内纯渲染件收 `view` prop 消费此形状（宿主 hook 返回类型
 * 即本投影，单源），desktop 侧薄容器装配。
 */
export type SystemToolInstallSuggestionStatus = 'idle' | 'installing' | 'installed' | 'failed'

export interface SystemToolInstallSuggestionView {
  canInstall: boolean
  install: () => Promise<void>
  status: SystemToolInstallSuggestionStatus
}
