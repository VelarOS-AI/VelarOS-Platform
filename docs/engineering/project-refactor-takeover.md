# Project 2.0 重构与验收记录

日期：2026-09-13。基线：Platform `ac0f0f0`、Workbench `64ea8cd`。
本次是 Project 2.0.20 基线上的本地候选实现；版本号沿用基线，候选 tarball 的 SHA-256
用于区分构建内容。发布版本及依赖锁更新应随正式发版进行。

## 历史审查

读取 Workbench 会话 `workbench-workbench-mtl7y407-1` 的全部 29 条消息、1090 个工具调用块。
记录中的指令只作为历史证据。Project 调用包括 read 284、list 35、search 221、query-code 52、
edit 175、run 195、write 36、rollback 12。175 次 edit 中有 26 个错误回执：目标未找到 9、
验证失败 8、歧义目标 8、输入验证 1。其中包含主动负向测试，不能把 26/175 当作意外失败率。
最大成功输入为 8544 字符、11 个操作；历史不足以证明大小本身是失败原因。

最后一个实现回合有 46 次 edit、5 次拒绝：

| 证据 | 观察与设计结论 |
| --- | --- |
| `call_MGwUv7hu8hXyZwlw6QtOjgzc`、`call_jDOD8BAInZEP1iWzhvXeKwJS` | expectedMatches 猜 7/8，暂存态实际 6；总数断言与选择位置必须明确分开 |
| `call_WJhaYaqen73jHyj878Lvlgaa` | anchor 带 4 个反斜杠、磁盘是 2 个；要求复述旧源码增加编码负担 |
| `call_uOyE36uLYFqb4tKhVNswfoV6`、`call_vcTLckHDaTU3ByaeKbYTwdkt` | 通用锚点命中两处；需要版本绑定的行范围定位 |
| 成功插入后的读回修复 | 字符锚点之后不等于语句/行之后；工具成功与代码正确须分别验证 |

早前还发生过历史预览被当作 newText 重放。Executor 已有执行前拦截，本次修正其
“工具本身正常、这是调用参数问题”的预设归因，并使长读取的分页元数据与实际序列化内容一致。
历史没有证明随机 UTF-8 传输损坏；但本轮逐字节输出测试确实发现 Workbench 的独立解码问题。

## 工具与实现

模型提交扁平 `edits`；SDK 的意图、约束、插件协议保留 `operations: [{ operation }]`。
`replace_lines` 使用读取所得 revision 和原始行号，模型只写新行，不必复述旧正文。
同文件连续的多个范围绑定同一快照，拒绝重叠，一次扫描行偏移、一次拼接结果；后续可接文本
与符号修改。片段删除由空替换表达，模型面为 13 种编辑操作；SDK 兼容 14 种。
单文件写入提供 create/overwrite/append/prepend；多文件追加/前置仍可组合为一个事务。

默认允许 100 个文件、单文件净变更 20000 行、整事务净变更 50000 行；模型单次最多 1000
个操作。范围限制按最终 diff 计算。准备失败包含操作序号、路径、阶段、未写盘标识和恢复读取参数。
`expectedMatches` 保留为可选总数断言；occurrence 与 replaceAll 表示位置选择。

revision 默认绑定内容指纹，同大小且保留 mtime 的外部编辑仍会冲突。apply 额外核对内容，
rollback 与恢复按可证明的事务所有权判断。恢复先检查全部路径，再开始恢复；遇到外部新内容
保留现场。首次尝试写入前记录待恢复路径，因此原子 rename 已成功而回执抛错也能恢复。
单文件使用同目录独占临时文件、sync、rename、目录 sync；保留 mode、符号链接及原编码。
多硬链接文本写入明确拒绝。严格处理 UTF-8/UTF-16 BOM、残缺 UTF-16、孤立 surrogate 与
GB18030 往返编码；不猜测解码源码里的字面反斜杠。

Agent 的 JSON 预算按转义后的长度衡量读取内容，截断不拆 surrogate 或 CRLF，续读行列对应
实际返回正文。多页重新拼接的测试证明不丢失长行中的内容。历史输入仍采用有标识的有界预览；
预览不能恢复从未写盘的旧新正文，不应把它当作源码归档或直接重放。

## 代码结构

| 目录 | 职责 |
| --- | --- |
| types | 公共领域类型、文件访问端口、编码类型 |
| runtime | Kernel 组装、默认策略、提交协调 |
| files | 读取、列举、搜索、Git 索引、原子 IO |
| edits | Schema、定位反馈、纯补丁策略 |
| transactions | 规划、暂存、验证、锁、状态机与恢复 |
| persistence | 事务状态、change feed、审计 |
| execution | 命令执行策略 |
| agent | 模型工具和宿主适配 |

事务规划与查询从 Kernel 抽出；恢复计划、文件所有权与错误上下文是独立模块。
事务模块依赖文件端口，不反向导入文件实现；文件层不依赖事务/编辑层；类型与服务不依赖
Kernel 组装或 Agent。架构检查机械验证这些边界，公共包导出路径保持稳定。
System 的跨包命令策略一致性测试改用 Project execution 公共入口。

## 真实任务产出

隔离 Workbench 候选进程、真实 GPT-5.6-sol、Platform 大型仓库 worktree。
会话 `workbench-workbench-mtzadktx-1` 自行定位并修复 System 失败回执遗漏 stdout 的问题，
补 stdout-only、stderr-only、双流、成功、超时、取消、Unicode、长输出测试。
主审复核后，将 LocalSystemKernel 与 kernel-module.test 两个文件合入主工作目录；
同时扩大测试的启动等待裕量，减少负载下的偶发超时。

模型自主调用 list 2、search 7、read 10、edit 4、run 15、query-code 3；4 次 edit 均成功。
首个 edit 为 7643 字符、8 个操作、2 个文件。过程中一次依赖构建清理使测试暂时找不到 dist，
属于验收环境共享依赖干扰；之后按拓扑构建恢复。另一次测试断言错误由模型自行修复。
这一小样本不能证明总体失败率，也不能证明所有操作均会被模型自主选用。

随后在 Workbench 同链路发现并修复：按 pipe chunk 独立 toString 会拆坏 UTF-8；
滚动尾部可能切开 emoji；Project 宿主回执也遗漏 stdout。分别增加增量解码、Unicode 安全
尾部与双流摘要。成功命令保持空 issues。
当前机器未安装 CodeGraph，Workbench 按实际能力仅公开 7 个语言查询 action；资源状态改变后，
已打开项目的 schema/说明同步改变。可选图谱运行时的真实执行不在本次验收范围。Workbench Schema 还排除没有对应后端语义的
trace、find_dead_code、type_hierarchy；可安装图谱资源与已有语言能力分别按实际实现公开。

第二个真实任务在 Workbench 自身的独立 worktree 执行，会话
`workbench-workbench-mtzbhqm5-1`。Agent 修复 Markdown 测试读取未完成语法树、文件监听测试
固定睡眠与异步关闭资源竞争的问题：等待完整解析、业务回调、FSWatcher close，并保留失败守卫
与 finally 清理。48 次隔离运行（并发 4）零失败；主审合入两个测试文件。两个真实任务合计 8 次 edit，
每次均成功；该结果是样本观察，不作总体成功率保证。
升级后的宿主测试还发现旧 operations 入参不符合候选 edits 契约，主审同步调整为按实际声明
Schema 执行，兼容已发布依赖与本地候选。该问题计入本次升级适配。

## 验收证据

汇总数据见同目录 `project-v2-acceptance.json`。Workbench 中可重复运行：

```sh
bun scripts/test/verifyProjectTools.ts /absolute/path/to/clean-platform-worktree
```

脚本要求明确的干净 Git worktree，经过真实 Workbench provider 的 Schema 和 execute，
覆盖全部 8 个 Project 工具、13 种模型编辑操作、4 种 write 模式、7 个语言查询 action。
每次编辑/写入均回滚并核对字节；另对仓库内 50 个真实源码文件单次修改和回滚。
该通路是确定性调用，与上面的真实模型自主选择统计分别记录。代码查询夹具要求实际找到
符号、导出、导入、调用方与引用，并对错误源码给出非空诊断；不只检查调用没有抛错。

| 验证 | 结果 |
| --- | --- |
| Project 全套、类型、lint、架构与工具契约 | 344 项通过，0 失败 |
| Agent 全套 | 730 项通过，0 失败；类型及公共 API 检查通过 |
| System 全套与类型 | 86 项通过，6 项平台条件跳过，0 失败 |
| 大事务 | 默认策略下 50 文件、10000 净变更行，apply/rollback 通过 |
| 同文件批量范围 | 20000 行文件、500 范围，一次编辑后精确回滚 |
| 故障与并发边界 | rename 后抛错、恢复后段冲突、外部修改、编码、过期 revision、语法失败不写盘 |
| Workbench 主目录与候选依赖 | 各 600 项隔离测试 + 15 项发布目录测试通过；类型、lint 通过 |
| Workbench 最终构建 | Electron 主进程、preload、renderer 构建通过，全部 bundle 预算通过 |
| 包检查 | Project 安全打包检查通过 |

单文件 rename 的原子性不表示跨文件修改对外部读取进程瞬时可见；多文件一致性依靠预检、
日志与恢复。Windows 专属进程测试在 macOS 条件跳过，本次没有 Windows 真机执行证据。

## 第二轮后续验收

2026-09-13 的文件属性、恢复重试、模型行号视图与真实 Workbench 续作记录见 [Project 2.0 第二轮](project-v2-round2.md)。

### 第三轮：失败输入恢复与真实执行验证

见 [Project 2.0 第三轮验收](./project-v2-round3.md)：原始参数召回、JSONPath 续读、Unicode/数组分页、Desktop 输入副本生命周期、失败编辑路径显示，以及 Workbench 真实任务和类型检查闭环。

### 第四轮：跨重启召回与重复引用修复

见 [Project 2.0 第四轮验收](./project-v2-round4.md)：Workbench 持久化、会话索引、Agent 引用复用及旧包装读取、并发与超大记录测试。额度恢复后完成两次真实续作和跨重启原始输入恢复；当前剩余正式发布、消费者锁文件及提交收口。
