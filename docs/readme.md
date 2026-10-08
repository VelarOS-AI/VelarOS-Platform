# Platform 文档

当前公开接口以包 exports、合同和可执行验收为准。本文组织持续维护的架构、开发与评测入口。

## 架构与运行

| 文档                                                                              | 内容                             |
| --------------------------------------------------------------------------------- | -------------------------------- |
| [Platform boundaries](architecture/platform-boundaries.md)                        | 产品、宿主与 Platform 的职责     |
| [Repository topology](architecture/repository-topology.md)                        | 包、依赖方向与仓库布局           |
| [模块结构与所有权](architecture/module-ownership.md)                              | 合同、实现、注入与目录治理       |
| [模块说明规范](architecture/module-readme.md)                                     | 模块 README 的内容和示例要求     |
| [Platform 运行主链](architecture/platform-runtime.md)                             | 协议选择、执行、完成、交互与恢复 |
| [Skill 与标准 Node 运行环境](architecture/skill-runtime.md)                       | 标准 Node、Skill 与持久 npm 环境 |
| [浏览器日常任务与 ScriptAct Bridge](architecture/browser-scriptact-bridge.md)     | 外部模型驱动与浏览器 Host        |
| [长程上下文](architecture/long-running-context.md)                                | 历史封段、叙事、观察和容量       |
| [ScriptAct 文本协议：设计复核与执行约束](architecture/scriptact-text-protocol.md) | 文本控制段的语法与接收约束       |
| [观察脚本与结果租期](architecture/script-context-leases.md)                       | 观察与执行结果的展示寿命         |
| [ScriptAct 声明式观察输出](architecture/script-output-observation.md)             | 观察输出、预算与派生展示         |
| [脚本增量编辑与版本发布](architecture/script-incremental-edit.md)                 | 程序版本与精确修改               |
| [Act 模型自管理空间](architecture/act-system-space.md)                            | 模块发现、目标、记忆与共享存储   |
| [高级搜索：正式运行链路](architecture/advanced-search.md)                         | 有界搜索、续接与证据             |
| [存储适配规范](architecture/storage.md)                                           | 存储端口与适配器                 |
| [VelarOS shared resources](architecture/shared-resources.md)                      | 跨产品共享的运行资源             |
| [Runtime assurance and observability](architecture/runtime-assurance.md)          | 授权、可观测性与进程约束         |

## 开发与交付

- [仓库说明](../README.md)与[包目录](generated/package-catalog.json)：安装、工作区和公开包。
- [代码规范](engineering/code-standard.md)、[门禁覆盖](gate-coverage-matrix.md)：实现与验证。
- [本机发布](engineering/local-package-release.md)、[消费者更新](engineering/platform-consumer-updates.md)、[依赖安全](engineering/dependency-security.md)：发布与依赖管理。
- [模块与 Mod 接入](mod-dev/README.md)：最小示例、注入点、权限、包格式与宿主装配。
- [Act 能力目录](../packages/velaros/act/README.md)：生成的操作、效果和模板。
- [架构决策](decisions/README.md)：现行规则的设计依据。

## 评测

- [评测规范](engineering/scriptact-acceptance-criteria.md)：冻结配置、独立验收、完整计量与恢复。
- [Agent Lab](../packages/agent-lab/README.md)：`eval:act` 使用的驱动、核验、归档与统计包。
- [架构](agent-lab/architecture.md)、[测量方法](agent-lab/methodology.md)、[宿主接入](agent-lab/integration.md)。
- [长任务运行器](../scripts/agent/long-tasks/README.md)：独占任务资源、候选准备、评分与归档。

## 验证记录

以下记录按各自冻结的源码、任务与时间解释，原始观测和未知项随记录保留。

- [评测结构、结果与优化经验归档](engineering/evaluation-retrospective-20261007.md)
- [Runtime 静态与动态联合审查差量报告](engineering/runtime-context-audit-20261006.md)
- [Runtime 修复与三轮追加对照差量报告](engineering/runtime-review-followup-20261006.md)
- [普通 Desktop 项目的完整交付复核与完整模型请求账本](engineering/scriptact-completion-review-20261008.md)
- [ScriptAct 新任务对比、产品修复与证据发布](engineering/scriptact-evidence-20261007.md)
- [ScriptAct 完整交付目标：当前验收清单](engineering/scriptact-goal-audit-20261007.md)
- [ScriptAct 真实缓存验证与修复](engineering/scriptact-live-cache-validation-20261007.md)
- [ScriptAct Desktop 原生评测](engineering/scriptact-native-desktop-evaluation.md)
- [ScriptAct 下一代实现与证据](engineering/scriptact-next-generation-implementation.md)
- [ScriptAct 后续优化与验证，2026-10-07](engineering/scriptact-optimization-20261007.md)
- [ScriptAct 优化实现与收益证据](engineering/scriptact-optimization-implementation.md)
- [ScriptAct 并行评测环境与修复循环](engineering/scriptact-parallel-evaluation.md)
- [ScriptAct：project 与标准 Node 的真实仓库任务对比](engineering/scriptact-project-ablation-20261007.md)
- [ScriptAct 工具协议实现与实测（2026-10-07）](engineering/scriptact-protocol-ab-20261007.md)
- [ScriptAct 两种传输的模型提示分流](engineering/scriptact-protocol-prompts-20261008.md)
- [标准编程环境与宿主能力发现](engineering/scriptact-standard-runtime-20261004.md)
- [标准运行时：输入精简与原生模块发现](engineering/scriptact-standard-runtime-v2-20261004.md)

## 维护约定

持续维护的说明只写当前合同、用法与理由；行为变更同步更新相应入口和测试。阶段工作记录按其验证身份保存，过程流水账由 Git 历史承载。调整文档时同步修正链接、示例和调用方引用。
