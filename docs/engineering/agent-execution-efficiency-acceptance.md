# Agent 执行效率验收

日期：2026-09-13。设计见 [执行效率与失败恢复](./agent-execution-efficiency-design.md)。

## 验证环境

Platform、Workbench、Desktop 使用独立验收 worktree（分别基于 `3c6e7c1`、`c8515c9`、`eb87fc0b5`）；大型项目目标为包含 2,383 个受跟踪文件的 Platform checkout。Workbench、Desktop 的测试依赖装入安全打包生成的 Agent 0.6.27 和 Project 2.0.23 tarball，并统一嵌套包引用。Agent Lab 0.1.4 统计模块直接读取 Workbench 磁盘执行回执。

## 实测参数复用

受控模型通过真实 WorkbenchAgentExecutionStack 发起包含 3,000 行 Unicode/反斜杠正文的编辑。首次锚点错误，磁盘原文保持不变；第二次只更正 oldText，保存正文逐字一致。磁盘回执经过 Agent Lab 统计得到：

| 指标 | 结果 |
| --- | ---: |
| 首次模型输入字符 | 45154 |
| 重试模型输入字符 | 120 |
| 重建后的完整重试参数字符 | 45155 |
| 重试省去的重复字符 | 45035 |
| 重试输入减少比例 | 99.73% |
| 实际尝试 / 未应用失败 / 成功 | 2 / 1 / 1 |
| 未知结果 / 损坏回执 | 0 / 0 |

字符统计没有使用模拟模型报告的 token 数，不推算线上费用或成功率。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| Agent 完整测试 | 769 通过，113 文件 |
| Agent 类型 / 浏览器边界 / API | 通过；相对基线 16 项新增、5 项兼容修改、0 项删除 |
| Project check | 374 通过，34 文件；类型、lint、架构和工具合同通过 |
| Agent Lab check / build | 44 通过，11 文件；类型、架构、构建通过 |
| Workbench 大型项目执行栈 | 2 通过，包含文件版本流和大输入差量重试 |
| Workbench 完整测试 | 648 通过，109 文件；发布脚本另 15 通过 |
| Workbench 类型 / 生产构建 / 体积预算 | 通过 |
| Desktop 存储回归 | 6 通过；覆盖参数、回执、领取记录和文件档案的同步/异步增量保存与清空 |
| Desktop 受影响类型分区 | node-core、node-agent-context、node-tests-core 通过 |

关键边界包括：大段中文/emoji/CRLF/反斜杠保持一致；来源待执行、结果未知或已成功时拒绝复用；跨会话/workspace/工具拒绝复用；同源并发重试只领取一次且重启后仍拒绝重复领取；原型链与越界修改拒绝；旧编辑引用拒绝覆盖，半行或越界读取不发定位引用；校验失败无 diagnostics 也不能算通过；源码变化令语法证据失效；读写排队与等待取消。

现有压力回归继续覆盖 20,000 行内 500 处编辑、100 文件事务和有界当前文件投影。

## 候选交付

| 包 | 版本 | SHA-256 |
| --- | --- | --- |
| agent | 0.6.27 | `1e69300c6782f5895a2e8b4aa844328dd1560c77efcb28b51bff250a2dfca5a5` |
| project | 2.0.23 | `0bdcacf2dd7f537d370e652bcf7ac6bf662aea5203dbe7e34f40b3ee67c2b89c` |

候选目录：`/var/folders/qp/3d1vmxms7jqcm8353whb8h_80000gn/T/velaros-file-context-pack-HNCUR8`。主 checkout 保留实现源码；宿主正式依赖与运行中的应用仍需经过正式发布交付。

这轮证明了真实宿主执行栈、磁盘保存和包集成的确定性行为。外部模型的自然工具选择、长会话费用、线上成功率与 GUI 交互不在本轮测量结果内。
