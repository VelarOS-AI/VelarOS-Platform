# 模型列表改由鉴权目录提供

服务商标识、协议与默认地址仍由 Model 的运营清单维护；可选模型只能来自当前服务商、地址、密钥下的 ProviderModelCatalogService，或用户明确输入。已知窗口和能力规格仍是参考元数据，不代表账户可用型号。

同步 ModelCatalog 的 catalog/models/suggestedModels 不再提供硬编码候选和首次型号，resolveModel 仅保留明确输入；ModelProviderCollection 的普通与脚本预设采用相同边界。DefaultProviderModels 全部留空。接口形状保持，首次配置行为改变，产品必须接入动态列表。

INV-1 从同服务商内允许型号回退收紧为只保留明确选择；INV-8 从静态默认表一致改为不提供静态候选，并保留公开快照隔离。旧承诺会让宿主把过期型号当成当前可用模型，因此更改并由原编号验收覆盖。

动态目录不再给专用运行时生成 source=preset；脚本返回空列表也保持空，不从 manifest 的型号列表补齐。鉴权作用域缓存、取消和远端错误继续由同一目录服务持有。

Server 接入该公开服务，在服务端按相同连接身份解析已存密钥。浏览器草稿查询不会保存配置，关闭、切换服务商/地址/密钥时取消旧查询；失败显示失败并保留自定义模型入口，不回退静态列表。

已在 main 的 `4bdd09df58fd86898543992d6e36cdd5a5f64925` 发布正式基础及能力配对归档 0.12.1（tag v0.7.13）；[发行检查 43174058195](https://github.com/VelarOS-AI/VelarOS-Platform/actions/runs/43174058195)通过，正式 manifest 和 validation 随包发布。基础 SHA-256 为 `191e4391ce31e98517f785a1f354d37337cca17d1f63ee2c86a3f8523caab76c`。前一 v0.7.12 只在源码格式检查失败，未发布归档；保留该 tag，不改写历史。

Server 已按官方固定 URL 安装基础 0.12.1 与 UI 1.1.3，未安装 capabilities。普通与冻结安装、实际 SDK 身份、严格类型、认证/目录 HTTP 测试、真实 Runtime/审批/Node 接缝及网页构建通过；实际浏览器使用本地供应商接口确认动态型号与错误显示。消费回执由 Server 的 `docs/evidence/dynamic-models-20261112.json` 持有，旧 Linux 产品制品不重标为本版本。
