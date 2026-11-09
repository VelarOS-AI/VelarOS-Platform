# 0.9.1 会话控制与 Host 接缝差量

日期：2026-11-09。上一批源码为 `697bcba2fdff5b7160116a7c936876df8bf4abb2`。0.9.0 的两份归档冻结不变；本批修复真实产品接入缺口，目标组合为基础与 capabilities 均 0.9.1，平台代仍为 0.7。

## 合同与实现

- 新增根 `openSessionControl({ sessionId, storage, binding })`：仅笔记、目标与关闭；无模型、执行器、Host、Kernel 或领域模块装配。复用 SessionGoal 和抽取后的唯一 SessionNotes，不另建上下文或 Agent 循环。精确签名与迁移用法见 [ADR 0029](../decisions/0029-session-control-lease.md)。
- 控制读取核原执行身份、授权与持久模块清单完整性，不重写绑定，不伪造可执行模块；正式执行仍核对实际全部模块 instance/generation。不存在会话的读取为空/null，控制与正文读取为 NOT_FOUND，不创建空会话。旧 workspace 绑定拒绝。
- GoalControl 的 baseRevision、状态机和持久 CAS 不变；resume 只改目标事实。笔记分页、revision 与当前任务/历史重置水位不变。新 lease 在缺笔记时精确转换为 NOT_FOUND，原 Runtime 的既有码保持。
- lease 成功接管该次存储连接；初始化失败仍由调用方关闭。close 封闭新准入并等待已受理操作落定，再关闭连接，不取消已受理 CAS。产品仍负责自身的串行控制和删除排斥。
- `/node` 新增 `resolveNodeRuntimeBinding`，与 createNodeRuntime 共用原身份算法，只解析目录、用户、可执行文件和明确策略；不创建资源。持久绑定格式仍为 version 1，没有新数据迁移。
- PTY 修复归 execution：异步终端先等有效 PID、登记受管对象，再发布任务；复用既有启动期限，支持取消和提前退出。原 task/session/managed/PID 身份核验保留。停止走真实 terminal.kill，Windows 不传 POSIX 信号，终态仍等 onExit；未重放隔离的 C2 变更。
- capabilities 的 Electron/React/类型 peer 恢复源码声明支持范围与 optional 标记；基础 Node 不加入 UI peer，真正 dependencies 继续固定版本，基础 required peer 精确为 0.9.1。新增声明 peer 关联仅在对应运行包被当前发行单元引用时生效，避免漏掉 React 声明提供者。
- sessions.tell 的平台合同与模板没有变化。Workbench 旧 Host 的 untilIdle→submit 路径应改为现有活动 Session.steer 的准入；空闲拒绝，queued 表示活动运行已接纳 guidance，不创建下一轮输入。

没有新增模型操作或供应商协议。生成目录与包版本同步；不新增 workspace、People、Team 或产品模式分支。

## 必要验证及复用

- Velaros 单次定向构建通过；新增控制集成 2/2，真实 SQLite 与正式 Node/Project 写口生成事实，覆盖恢复、分页/revision、目标 CAS、错误身份与旧绑定、缺失会话零写入及关闭等待。
- peer 范围与声明 peer 两个定向纯逻辑用例通过；已有发行和执行回归结果保留，不重复全套。
- 受影响 Velaros 所有权检查通过；README 示例 33 段通过；错误构造门 1097 个产品文件通过。README 过长的问题定向压缩后通过，不更改行为承诺。
- 新基础归档复用本批已打包身份；扩展声明 peer 的元数据遗漏被消费门拦下后，只重包该扩展，保留失败尝试身份，不重建基础或重跑已绿行为。
- 新扩展与冻结 0.9.0 逐文件比对，除版本、精确基础 peer、已声明宿主 peer 范围/optional 元数据和 README 版本外，代码与资产必须完全相同；据此继承原扩展业务 JS 证据。

Windows 真实 PTY 停止及自然退出须由 Server owner 仅复验其 `terminal-seam` 失败路径；Platform 的假终端用例不冒称该原生资源问题已通过。候选交接只提供本批固定两包，不为产品覆盖旧文件或自动改依赖。

固定的 0.9.1 验收归档：基础 SHA256 `7845f1e6c90fd93f90faf8d5c52203a7110580054365419acb1c38d72d0e93c2`（2,217,426 bytes），capabilities SHA256 `9e29f4b00ee12aa51a2d086b32eaff8ce7c15672041048590cac0dc6ba911a5a`（7,148,180 bytes）。独立归档 JS 控制消费与 skipLibCheck:false 通过，冷控制阶段 child_process 尝试为 0；扩展比较 4066 个条目通过，只有明示的版本/peer/README 变化。

小交接 receipt 的绝对路径：`D:/Projects/VelarOS-Platform/.velaros-workspace/candidates/platform-0.9.1-7845f1e6-9e29f4b0/candidate.json`。初始打包的失败扩展身份保留在原始 receipt 的 supersededArchives；交接只选上面两份最终身份。新目录不覆盖 0.9.0，后续产品验证只追加证明，不改变包字节。

## 0.9.0 补充的冻结来源与 Linux 证据

638 个原始输入 SHA256 全部匹配保存清单；Git 过滤后的 blob 全部匹配 `697bcba2` 的树 `9fadc279ecc5d06f09f16b38eb8993ff6c1515ff`。证明保存在冻结候选目录的 `source-proof-697bcba2.json`，原始 dirty 来源保留。

Linux CI： https://github.com/VelarOS-AI/VelarOS-Platform/actions/runs/42565071313

一次 Ubuntu 22.04 / Node 24.22.0 任务共 16 秒，直接安装固定基础 SHA256 `ba4c31c49582380d84f63b884c44bc2fbd4897bb45bbda6a33ad68f1aa789045`，完成输入、确定性模型驱动 3 次调用、真实命令/文件、交互、子进程取消及恢复；未源码重建、重包、跑扩展或供应商矩阵。验证分支只承担此任务，不改主分支或部署产品。

receipt 绝对路径：`D:/Projects/VelarOS-Platform/.velaros-workspace/candidates/platform-0.9.0-ba4c31c4-7455cef2/candidate.json`。
Linux 证明绝对路径：同目录 `linux-validation.json`、`linux-job.log`。
原始来源指纹：`9755d000d987ace0a631467d8765993f23ff0d027eab65676b23c6104c629ea4`；提交输入指纹：`38006ce55801fabf10c4cc908edeb3af76fcdf90d6be97807840cf126e7f60d2`。

这份 Linux 证明仍只覆盖该冻结基础及既有执行链；不把它写成新 PTY 路径或实付供应商验证。模型协议未改，本轮不再重复付费调用。
