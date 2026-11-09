# 0.9.2 只读会话事实与集中发行差量

Desktop 与 Workbench 的实际公开调用库存核完后，唯一剩余 SDK 缺口是空闲/重启后的 trace 与 traceBranches。0.9.2 为同版基础与 capabilities，根火车为 0.7.2，平台代仍为 0.7；0.9.0/0.9.1 固定归档不变。

## 公开合同及理由

`SessionControlLease` 新增 `trace(input?: ActTraceQuery): Promise<ActTracePage>` 和 `traceBranches(): Promise<ActTracePage['branches']>`。读取固定在 lease.id 根范围，逐次复核原执行身份、授权范围和绑定完整性；支线继续使用既有持久归属检查。缺失根为空，跨根支线拒绝，不写入或绑定空会话。

复用原 RuntimeTrace 和 Context journal 的只读方法，不另造 Context、Kernel、Agent、模型、执行器或 Host。沿现有 perform/pending 封闭关闭准入，等已受理读取收束后再关闭该次独立存储连接。完整签名及产品接入见 [ADR 0029](../decisions/0029-session-control-lease.md)。

原 ActTraceQuery 类型、模型请求/会话活动游标、每页上限、正文共享预算、显式 fullContent 语义和非原子快照说明不变。不新增完整请求归档、历史重建或图片副本，没有模型操作、schema、提示词或供应商协议差量。README 示例直接使用公开 lease。

本候选包含 e683d1ef 的四处内部错误边界修复；原因、合同影响和既有定向绿证据见 [错误边界差量](error-boundaries-cleanup-20261109.md)。这些用例不因本次发行再次运行。

## 固定归档与验证

正式发行继续核验干净源码、精确本地/远端 tag、声明工具链、冻结依赖和既有有界发行门。每包只通过 safe-package-pack 打包一次；基础的同一归档在上传与公开前做新增只读 trace 的独立 JavaScript 和 skipLibCheck:false 声明消费。两包固定字节、源码、tag、SHA 和消费结果保存在候选 receipt；公开 release 前再次核验，不把源码验证写成归档验证。

新增定向证明只准备本次追踪所需持久事实，不复跑原真实 Node/PTY、Linux 基础链、长期模型任务或付费供应商。执行主机与具体证明路径以候选 receipt 为准。旧 Windows PTY 产品证据、Linux 0.9.0 和四处清理结果保留各自范围，不扩大结论。

发布状态及实际地址以最终 release-manifest 和 GitHub 资产为准；此文不把尚未产生的 tag、URL 或哈希当已发布事实。
