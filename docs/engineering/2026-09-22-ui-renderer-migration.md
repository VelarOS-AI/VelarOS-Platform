# UI 与文档渲染器归属迁移差量

日期：2026-09-22。Platform 起点 `71fa202a`；Desktop 起点 `eb87fc0b5`，保留迁移前的工作区改动。

## 归属

- VelarOS-UI：UI 包（组件、会话、HTML 工件）、component-library、测试、脚本、基线、ESLint 配置、设计核验记录，656 个原受版本控制文件逐一核对迁入位置。
- VelarOS-Desktop：document-renderer 包、独立产品、构建/发布脚本、工作流哨兵、相关说明，34 个原受版本控制文件逐一核对迁入位置。
- 模块登记与检查、声明规范化和安全打包基础设施跟随新 owner；Platform 包清单、锁文件、路径映射、发布门和生成目录反映当前 10 个包。

## 实现与契约

工具定义、公开 provides/requires 接口、UI 公开入口及渲染命令协议沿用现有契约。

渲染器复用 Desktop 已安装的 core 0.4.2 和 office 1.1.11。OfficeRenderer 调用已有函数，并将旧版 OfficePdfPageRenderError 转为既有 UNSUPPORTED_FORMAT 回执。真实路径解析与按目录分隔符检查边界由包内 paths 工具提供，保留最近存在祖先及悬空链接处理，追踪上限登记于 tuning。Desktop 锁文件仅新增渲染器 workspace 与链接记录；原有依赖版本保持一致。新增独立类型检查分区，遵循现有顺序执行、2GB 内存、45 秒预算。

UI 展示站为 HTML 工件的两个公开入口配置明确源码别名；UI 根检查涵盖包构建、类型、lint、测试、模块和语言规则、UI 门禁、安全打包与展示站构建。

## 验收调整

- 文档渲染 spec/acceptance.test.ts 原样迁入。INV-6 保持 ..cache 合法的承诺；登记文字中的实现位置随 Desktop 依赖版本改为包内目录边界判断。
- 渲染测试的 Excel/PDF 夹具使用显式开发依赖；新增旧版 Office 页码越界回归，验证错误码和输出文件行为。
- 发布身份测试指向 Desktop 官方源仓。工作流测试核验渲染器自己的发布哨兵；原来假设整个仓库只有 Platform 四个工作流不适用于 Desktop。发布顺序断言新增渲染器专属质量门。
- 原 Platform 会话检查中的两条 UI 输入语义断言迁入 UI 的 inputConversationSemantics.test.ts；Act 投影检查由 Platform 执行。

## 核验

- 渲染器：10 项协议/真实渲染测试、22 项发布测试、模块所有权、构建、脚本规范和脚本登记、sibling-source 边界、CLI describe 通过。
- Desktop 默认类型检查中 document-renderer 分区通过；随后 node-core 分区在迁移前已改动的 src/shared/constants/toolRendering.ts:10,12 报 ProjectToolNames.file/change 不存在，完整 Desktop 类型门仍受此影响。
- UI：322 项组件/会话测试、29 项 HTML 工件测试、构建、类型、lint、模块所有权、37 项语言规则、UI 静态门、外部消费打包契约、12 项安全打包测试和展示站构建通过。
- Platform：模块所有权、37 项语言规则、Kernel/Capabilities 架构、锁文件一致性、平台代、生成包目录、Act 投影、公开就绪、安全打包边界通过。
