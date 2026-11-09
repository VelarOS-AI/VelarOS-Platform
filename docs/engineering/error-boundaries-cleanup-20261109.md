# 错误与取消边界清理差量

本批基于 `e3e157696994a0d667cbd542a809484b93e40e71`，处理四处真实错误被兜底或遗漏收尾的问题。没有新增公开 API、模型操作、提示词或供应商协议；0.9.1 两份固定归档不变，后续与消费者合同统一进入下一固定候选。

| 范围 | 触发与改动 | 合同影响 |
| --- | --- | --- |
| Images | 前面图片成功、最后一张定位时取消，旧逐项 catch 会返回部分成功；批次结束再次核对 signal。 | 恢复 INV-10 的整次取消承诺，仍抛原取消原因；普通逐项失败行为保留。 |
| Context | 来源授权抛故障，旧 catch 会把命中静默丢弃；仅在授权阶段过滤明确的 DENIED，预览处理移出该 catch。 | 未授权 preview 仍不泄漏；来源故障、取消及预览错误保持原对象传播，不再伪装为空结果。 |
| Script | runner 自身拒绝时跳过原有监听移除及在途取消；拒绝路径取消本层调用范围，finally 移除外部监听后原样抛错。 | 恢复能力取消合同；成功路径的 unsettled 与未知效果语义不变，不伪造能力终态。 |
| Model | HTTP JSON 的数字/数组 message 通过类型断言混入字符串流程；以 unknown 解析并实际收窄对象/字符串。 | 有效供应商响应、401 和文本/HTML 规则不变；无效 message 使用原有有界正文，不以内部 TypeError 覆盖 HTTP 错误。 |

四个既有测试锚点各定向运行一次，全部通过：Images INV-10、Context A11、Script 注入 runner 的 INV-26、Model bounded provider error。测试使用磁盘图片、真实 Context fixture 和本地注入端口/HTTP 响应，不启动真实模型、终端或供应商调用。Model 一项用表覆盖六类响应及目录、凭据核验两个公开消费路径。

Context 只做一次受影响编译，Script/Model 无输出类型检查及八个改动文件 lint 通过；完整 `bun run check:module-ownership` 通过。格式化运行统一入口，并核对用户原有 `storage-index.test.mjs` SHA256 未变。没有重跑已有 Runtime、Server 原生终端、Linux 或归档消费链。

本轮另将 features、sessions 的全部生产文件和不变量读完，未为排查制造无关修改。Features 源模型文档的输入上限遗漏、Sessions 旧产品分类合同、Kernel 替换与关闭交错、Project 不可读文件假命中保留为明确后续项；不会据此声明其余模块已整模块清理。
