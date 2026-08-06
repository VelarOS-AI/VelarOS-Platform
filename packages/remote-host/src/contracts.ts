// 域:远程能力节点的产品面契约(宿主与 renderer 共用的纯身份与形状,零运行时依赖)。
//
// 薄壳可拆铁律②:任何领域判断进包,宿主侧只留端口适配 / 注册行 / UI 组件。因此本文件只放
// 「名字与形状」,不放任何判断;宿主 import 本模块与 `./composition`,renderer 只 import 本模块。

/** mod 身份。默认不启用,启用后工具面与设置页才出现(宪章 §16.3)。 */
export const RemoteHostModId = 'velaros.remote-host'

/** 工具类别 id。宿主只登记身份,实体工具由 mod 激活后动态投影进来。 */
export const RemoteHostToolCategoryId = 'remote-host'

/**
 * 一台已登记的远程能力节点。
 *
 * `url` 指向目标机器上 `velaros serve` 暴露的节点地址。**建议只填私有覆盖网(Tailscale /
 * WireGuard)地址**:本传输在应用层做设备密钥认证,但不自建 TLS,网络层加密与隔离由覆盖网承担。
 */
export interface RemoteHostDefinition {
  readonly id: string
  readonly label: string
  readonly url: string
  readonly enabled: boolean
}

/** 连接态投影,供设置页展示。刻意不含任何密钥材料。 */
export interface RemoteHostStatus {
  readonly id: string
  readonly label: string
  readonly connected: boolean
  readonly paired: boolean
  readonly nodeName: Nullable<string>
  readonly toolCount: number
  readonly lastError: Nullable<string>
}
