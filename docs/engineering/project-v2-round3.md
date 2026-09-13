# Project 2.0 第三轮：失败编辑的原始参数恢复

日期：2026-09-13。承接 [第二轮验收](./project-v2-round2.md)。本轮源码已合入三个主工作区，尚未提交或发布。

## 已修复的问题

1. **历史压缩后无法找回编辑输入。** 工具输出可召回，但大段 `newText` 和批量操作的原始参数没有对应入口。现在执行器在工具副作用之前，只为将被压缩的输入保存完整 JSON；历史预览携带 `__historyInputRef: input:<toolCallId>`。Agent 复用现有 `context:recall`，可按 `jsonPath` 取字段。普通小调用保持原样，工具参数没有新增必填字段。保存失败会在执行前终止，避免写入后才发现无法保留恢复资料。输入副本与输出使用独立的调用标识，重复内容的不同调用不会串用。
2. **JSONPath 命中长字符串或对象时忽略 offset。** 统一为可推进的字符窗口，返回 `nextOffset`、`totalChars` 和 `offsetUnit`。字符串窗口保留真实换行、反斜杠和 Unicode；对象窗口是完整 JSON 序列化的连续片段。
3. **超大数组条目被截断后当成完整条目跳过。** 旧实现返回无效 JSON，还把截断条目计入 `returnedItems`。现在返回有效数组和明确的 `oversizedItem` 子树读取路径，分页计数反映实际完整返回的条目。
4. **UTF-16/CRLF 分页边界及重复压缩失真。** 自动续页不拆开 emoji 代理对或 CRLF；顶层预览再次压缩保持稳定，300 项输入再次压缩仍保留正确的 200 项省略计数。
5. **Desktop 增量保存会回收独立的输入副本。** 输入副本随原调用保留，重载后仍可读；移除原调用或清空快照后可正常清理。
6. **失败编辑卡片显示“未知文件”。** UI 路径兜底支持 Project 2.0 的平铺 `edits`，并兼容已有历史中的 `operations[].operation`。成功结果仍优先使用规范化路径。
7. **真实任务的测试没有进入类型检查。** Workbench 原默认 tsconfig 没有包含该测试文件，类型检查通过不能证明测试类型正确。已修复夹具的 `toolOs`、模型运行时实例及 `resolutionSource`，改用已有的 `node:test`，并将该回归纳入默认类型检查。

分页逻辑独立到 `packages/agent/src/agent/context/retrieval/Pagination.ts`；输入副本保存独立到 `packages/agent/src/tools/toolInputRecall.ts`。原有公开导出保留。Agent 的可选参数和可选返回字段经过兼容性审查，版本推进至 `0.6.24`，更新 API 基线和 workspace lock 元数据；UI 为 `0.2.52`，Project 延用第二轮 `2.0.20`。

## 真实 Workbench 任务

候选宿主：`VelarOS-Workbench-project-v2-test`；真实任务目录：新的完整 Workbench worktree `VelarOS-Workbench-project-v2-round3-test`。模型为已配置的 GPT-5.6 Sol。

任务产物是有实际价值的失败调用恢复回归测试，最终审查后合入主工作区。两页召回正文严格等于 `longInput.slice(firstOffset)`，包含中文、emoji、反斜杠和 CRLF；第二页使用第一页返回的真实 `nextOffset`，并确认输入与错误结果互不混用。

审查了 82 次实际工具调用。第一笔编辑为 **4 项操作、10,276 个 UTF-16 字符**，因锚点计数断言被原子拒绝。Agent 自行调用 `context:recall`，按原始输入引用取回全部 4 项，再次整批提交成功。逐字段比对表明：所有文本参数完全一致，只把第 4 项的 `expectedMatches` 和 `occurrence` 从 3 改为 2。没有人工补发原始参数。

记录同时保留了后续的行范围拒绝、测试断言修正、Bun 命令参数顺序错误和真实类型错误。Agent 一度把“召回说明标题也参与了正文比较”误判为 Unicode offset 问题，审查后恢复 UTF-16 计数，并仅提取说明标题后的正文，逐字比较通过。该任务没有出现传输层编码损坏的证据。

这是一组真实任务样本，不代表通用零失败率。匹配计数估算、行范围选择仍是后续改善 Agent 编辑体验的重点。

## 验证

| 验证 | 结果 | 日志或记录 |
| --- | --- | --- |
| Project 完整 check | 360 pass / 0 fail | `/tmp/project-round3-check.log` |
| Agent 全部测试 | 739 pass / 0 fail | `/tmp/agent-round3-final-tests.log` |
| Agent build、browser、类型、lint、API 基线 | 通过 | `/tmp/agent-round3-all.log`、`/tmp/agent-round3-type.log`、`/tmp/agent-round3-lint.log`、`/tmp/agent-round3-public-api.log` |
| UI 全部 UI 回归 | 264 pass / 0 fail | `/tmp/ui-round3-all.log` |
| UI 构建、变更 lint | 通过 | `/tmp/ui-round3-build.log`、`/tmp/ui-round3-lint.log` |
| Workbench 主工作区完整测试 | 603 隔离测试 + 15 发布目录测试通过 | `/tmp/workbench-round3-main-all.log` |
| Workbench 最终候选完整测试 | 603 + 15 通过 | `/tmp/workbench-round3-final-all.log` |
| Workbench 主工作区和候选类型检查 | 通过，明确包含新增测试 | `/tmp/workbench-round3-main-type.log`、`/tmp/workbench-round3-final-type.log` |
| Workbench 主工作区完整 lint | 通过 | `/tmp/workbench-round3-main-lint.log` |
| 大型 Platform worktree 工具验收 | 8 个工具，53 次调用全部通过；目标保持干净 | [完整记录](./project-v2-round3-acceptance.json) |
| Desktop 存储回归 | 10 pass / 0 fail | `/tmp/desktop-round3-storage.log` |
| Desktop 改动分区类型检查 | 2 个分区通过 | `/tmp/desktop-round3-type.log` |
| Workspace lock 一致性 | 18 个 workspace snapshot 通过 | `/tmp/platform-round3-lock.log` |
| 最终候选 build 与 bundle budgets | 通过，主入口 3.71/3.75 MB | `/tmp/workbench-round3-final-build.log` |
| 最终候选冷启动 | ready、connected、两个模块 healthy、无 kernel error；截图已查看 | 候选 `project-v2-round3-artifacts/startup.json` 与 `final.png` |

额外压力回归包含 300 项、约 870 KB 原始输入在失败执行前保存；长字符串与对象经过数十页召回逐字拼回。使用已提交旧源码进行对照，确认旧数组页不是有效 JSON、旧字符窗口可切断 emoji，候选版本对应检查通过。

## 证据及边界

- [旧版与候选对照](./project-v2-round3-before-after.json)
- [实际执行历史审计](./project-v2-round3-history.json)
- [最终候选包与 SHA-256](./project-v2-round3-packages.json)
- [已安装文件与候选包逐文件核对](./project-v2-round3-installed-package-verification.json)：主 Workbench 与候选宿主的 Agent 1,691 个文件、UI 1,481 个文件均无差异。

Workbench 的原始输入召回当前沿用宿主既有的有界内存 payload store（400 条、32 MiB），重启或缓存淘汰后的引用恢复仍需下一轮补齐。Desktop 本轮覆盖了磁盘保留、重载和清理。历史版本未保存的输入副本不能仅凭一个引用被重新生成，召回未找到时必须如实返回。

后续重点：Workbench 的持久化召回；减少 Agent 猜测匹配数量和行范围的负担；进一步让正文和召回说明的边界清晰。现有保护仍应原子拒绝不确定修改，不能通过放宽断言掩盖定位错误。
