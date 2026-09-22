# Desktop 执行记录接入差量

日期：2026-09-22。

## 本轮链路

Platform 的 Kernel 调用日志 → Runtime trace → 有界执行摘要 → Desktop 可靠 notice → 现有会话工具卡片 → 会话保存与重开。

Desktop 在模型回合切换时读取上一回合，运行收尾关闭 Runtime 前再核对本轮所有回合。按会话与调用身份更新同一条记录，内容未变化时不重复交付。成功或失败回执使用工具卡片；尚无完成回执与取消使用明确的状态文字。参数、返回值、错误和外部效果分别展示，正文截断有标记。

读取失败或证据缺失给出展示提示；不把诊断失败改写成实际执行失败。正式终态仍等待产品流的持久交付屏障。

## Platform 对外合同差量

- 新增公开数据 ActInvocationSummary，挂载于 ActTurnTrace.invocations[].summary；根入口与 contracts 入口导出。
- summary 从完整的 Kernel InvocationRecord 生成，包含 moduleId、operation、原始回执 status、独立的 effect，以及参数/结果预览与截断标记。无终态回执时为 pending；reconciliation 不覆盖原始回执语义。
- 参数最多 2000 字符，结果最多 6000 字符；二者计入 trace 与分页 trace 的 maxChars 总正文预算。摘要先于同条调用的 raw body 分配剩余预算，因而同一预算下原始 body 可能比原先更早截断；原始数据仍保存在 Platform。
- provides/requires 方法、工具定义和执行权限不变。手工构造 ActTurnTrace 的消费者需要补齐 summary。

## Desktop 归属与恢复

宿主不解析 Kernel 原始 JSON，也不根据会话结束推断调用成功。沿用既有卡片和会话持久化通道，不复制执行日志 owner。

本轮历史查看覆盖已投影到会话的记录。验证同时证明：原 Runtime 关闭后，不配置模型的新 Runtime 可通过公开 trace 读取同一份持久调用事实。当前 UI 按回合边界刷新；命令内逐段输出和集成前历史记录的批量回填另需独立接入。

## 验收差量

新增 INV-45，核对原始回执、未知效果、取消、截断及分页总预算。原 trace 索引验收保持。

Desktop 真实编辑/命令集成测试增加执行 notice 和关闭后只读追踪断言；轻量 fake session 补齐已存在的 trace 方法。新增收尾刷新晚到回执、追踪失败仍关闭资源的回归。renderer 验证重复交付、状态更新、保存恢复及恶意/畸形 notice 拒绝。原有执行、取消、持久恢复及可靠交付断言保留。

## 验证结果

- Platform 执行摘要、追踪索引、Runtime 和子运行回归：30 项通过。
- Desktop renderer 正文与执行展示回归：8 项通过。
- Desktop Runtime 与可靠流集成：Electron Node 环境 23 项通过，覆盖真实项目修改、命令执行、关闭后历史读取和取消回执。
- 21 个受影响类型分区通过；Platform 7 包拓扑构建、Desktop 生产构建及 Electron 入口产物校验通过。
- 两仓库模块归属检查通过。Desktop 架构增量检查保留 document-renderer README 的 6 项既有错误，该文件本轮未改。
