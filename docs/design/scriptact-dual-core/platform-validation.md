# Platform 统一主干验证报告

日期：2026-09-19。此次在当前工作树继续正式接入，没有提交或发布。既有包迁移与其他工作保留。

## 实际完成的阶段

| 阶段 | 完成内容 | 证据 |
|---|---|---|
| 主干统一 | 主模型与有界规划使用共享任务帧、存储、回执与预算；默认 active | 双核循环、类型检查与架构门 |
| 领域能力接入 | 12 个模块、94 个操作同源生成声明/schema/效果/模板，经同一工厂和 Kernel 装配 | 严格注册、输入拒绝、生命周期和全领域回归 |
| 脚本与进度 | 自动保存、sourceRef 重启复用；代码/输出/证据差量、图像变化、累计步骤和重复提示 | 真实 QuickJS + SQLite 集成 |
| 真实操作与视图 | 既有 Project/Files 操作经统一链路修改文件，物化最新版本；错误与效果分别保留 | 实际磁盘内容与回执断言 |
| 多模态主干 | 真实看图能力 → 持久附件引用 → 编译器 → AI SDK 图像块 | 真实 PNG 读取、MockLanguageModelV3 发送内容核验 |
| 平台治理 | 包边界、所有权、发布目录、公共 API、类型与浏览器入口 | 对应质量门通过 |

此前 Phase 1–4 的无模型闭环、主模型/上下文模型端口、领域核对与恢复继续回归通过。主模型及有界规划模型使用协议替身验证；真实供应商的效果实验另列。

## 本轮最终结果

**2,380 项不同自动化测试通过，0 项失败；6 项 Windows 原生测试在 macOS 跳过。**

| 检查批次 | 最终结果 |
|---|---|
| Agent + Kernel + Model + Script 测试与验收 | 1,224 通过 |
| Velaros 全领域操作测试与验收 | 1,094 通过，6 Windows 原生用例跳过 |
| Context 原始存储与证据视图 | 25 通过 |
| Velaros Runtime / DualCore / Platform Node 集成 | 31 通过 |
| Provider 发送协议与既有 Script 工具验收 | 4 通过 |
| 新生成器递归、联合、可选元组、字典与非 JSON 拒绝 | 2 通过 |

Script 的 81 项在补齐编码后再次通过；Platform 的 7 项及 Provider 的 2 项也单独复验，以上总数已扣除重复运行。

Core、Kernel、Context、Script、Agent、Model、Velaros 均构建及类型检查通过。宿主上下文类型由领域方法自动推导，错误领域参数的 `@ts-expect-error` 编译探针已加入 Velaros 的正式 typecheck。

通过的检查：module-ownership、kernel-arch、agent-arch、agent-public-api、model-arch、capabilities-arch、core-semantic-vocabulary、project-arch、lockfile-consistency、script 生成一致性、package-catalog、platform-generation、Agent browser surface。`git diff --check` 通过。

## 发现并修复的问题

1. 重启同一目标会把累计步骤与上一份视图丢掉，同时重新分配预算。现在保留步骤、用量、最近脚本和视图，并去重目标引用。
2. 领域声明只有静态脚本类型，运行时装配缺少统一可验证合同。现在同源生成 schema，注册时核对实际操作，按原接口推导宿主上下文。
3. 图像在新的文本视图路径缺少完整发送通道。现在图片独立持久化、按引用恢复，经同一编译器发送图像块，不受脚本文字截断影响。
4. 全领域验收的 CDP 模板使用 btoa 和 TextEncoder，QuickJS 未提供。现在编码在既有 QuickJS 堆内执行，补测 Unicode、二进制往返和 encodeInto 字符边界。
5. Context 缺少工作区发布目录要求的元数据。现已补齐并重新生成、校验 package catalog。

## 验证范围与待完成项

- 尚未运行真实供应商任务与四组质量/费用对照实验；不能据替身测试宣称模型效果或成本优于现有方案。
- Windows 原生进程、真实桌面控制、浏览器及产品宿主的联调，需要对应操作系统和宿主环境。
- 生产 runner 的发布认证仍由现有隔离认证流程负责；这次没有把未认证标记改为已认证。
- 当前内建证据源为 Project；其他来源通过 ContextSourcePort 接入，其版本、一致性和范围由对应适配器提供。浏览器、远端服务的专用证据源尚未逐个实现和认证。
- 不可变对象存储的回收策略、长任务规模评测和供应商图像 token 精确估算尚未完成。
- 未执行整个仓库面向产品发布的完整 release/check；本报告仅声明上表中的构建、回归和质量门结果。
