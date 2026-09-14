# 文件当前视图与历史召回验收

日期：2026-09-13。候选版本 Agent 0.6.26、Project 2.0.22。

## 环境与范围

- Platform 基线 `3c6e7c1`，Workbench 基线 `c8515c9`，Desktop 基线 `1179b137e`。
- 大型项目目标为独立 Platform worktree，包含 2,383 个受 Git 跟踪文件。
- Workbench、Desktop 各有独立测试 worktree 和依赖副本；安装由安全打包脚本生成的真实 tarball，并统一嵌套依赖的 Agent / Project 实例。
- 主 checkout 保留实现源码；宿主 package.json / lock 未切换到尚未发布的候选版本。正式依赖升级与发布属于后续交付步骤。

## 最终验证结果

| 验证 | 结果 |
| --- | --- |
| Agent 完整测试 | 761 通过，111 文件，0 失败 |
| Project check（build、类型与完整测试） | 368 通过，32 文件，0 失败 |
| Agent 类型、浏览器边界 | 通过 |
| Agent 公开 API | 10 项新增，3 项兼容扩展，0 项删除；候选基线已更新 |
| Workbench 大型项目执行栈集成 | 1 通过 |
| Workbench 完整测试 | 647 通过，109 文件；发布脚本测试另 15 通过 |
| Workbench 类型与生产构建预算 | 通过 |
| Desktop 存储回归 | 6 通过 |
| Desktop 受影响类型分区 | node-core、node-agent-context、node-tests-core 通过 |
| 三个主 checkout 的 diff 检查 | 通过 |

## 直接证明的行为

Workbench 集成用例使用 MockLanguageModelV3 驱动真实 WorkbenchAgentExecutionStack、ProjectCapabilityProvider、Project 内核、磁盘文件和磁盘 PayloadStore。模型的每次响应是受控的，发送给模型的实际请求被逐轮断言。

执行顺序：读取 A → 使用请求中的版本和行号改为 B → 召回 A → 使用当前视图改为 C → 完成。整个过程只调用一次 project:read；实际文件为 C，召回 A 逐字一致，召回过程不把当前指针改回 A。重建执行栈与存储对象后，A 仍可召回。

新增回归覆盖：

- 旧读取迟到、归档 IO 中途失效、重复同版本分页、完整内容与片段去重及引用对应。
- 相同正文的跨分支来源保存、历史折叠后重启恢复、workspace 隔离及子 Agent 读取/召回范围。
- 当前权限收紧、读取脱敏、直接引用自动识别及权限检查、单条档案损坏隔离。
- 外部修改保留文件大小和 mtime、提交 B 后外部立即写 C、重命名、删除和回滚。
- 提交成功后档案写入失败，成功编辑结果与上下文故障分别保留。
- 中文、emoji、反斜杠、CRLF 分页，以及单独 CR 后合法的数字管道源码。
- 20,000 行文件内同一事务 500 处编辑，当前窗口与最终 revision 相符，旧全文可分页召回。
- 同一事务修改 100 个文件，全部最终版本一致，实际 provider 请求通过总预算门，文件活动尾不超过 32,000 字符。
- 1,000 个路径失效时，在开始读取前限制为 100 个活跃路径；未变化刷新保持投影顺序。
- Desktop 的异步/同步 renderer 增量保存保留快照、来源、迁移记录；明确清空会话时清理。

## 结果解释与边界

这些测试证明确定性同步、版本隔离、归档和宿主接入生效。它们没有测量外部真实模型的自然调用选择、线上缓存命中、费用或长会话延迟。Workbench 使用生产构建验证了候选包的 bundling 和体积门；此轮没有替换已安装应用或进行 GUI 人工交互验收。

搜索、语义查询、诊断输出的统一版本元数据，以及超长会话的专用版本索引/保留配额尚需后续扩展。当前每次发送复核最多 100 个活跃文件；文件数上限和 token 上限不能代替实际磁盘吞吐、超长会话和多模型在线成本基准。

## 候选包

| 包 | 版本 | SHA-256 |
| --- | --- | --- |
| agent | 0.6.26 | `d8e2263dfdca0e281ac3409381e12ba77e2f6a20a93d57b1c86305c5977863d4` |
| project | 2.0.22 | `d09016bd0060876143da53f6890489a260464eb0d506d788b2de1fedf99eb9ec` |

本机候选包目录：`/var/folders/qp/3d1vmxms7jqcm8353whb8h_80000gn/T/velaros-file-context-pack-P7eX4K`。

详细实现见 [设计说明](./project-context-current-view-design.md)。新增验证分别位于 Agent `test/fileContext.test.ts`、Project `test/file-context-integration.test.ts`、Workbench `tests/workbench-file-context.test.ts` 和 Desktop `PayloadStoreEmptySnapshot.test.ts`。
