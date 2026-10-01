# ScriptAct 领域模块基础修复

日期：2026-09-30。本报告对应基础审核 M1–M7（主报告 F03/F04/F05/F06/F07/F10），以及浏览器 R2、记忆 R3 的后续修复。保留现有 TS 操作接口、生成模型面、宿主端口和领域实现分层；files 与 project 继续使用各自的编辑引擎。

修复针对权限复核、版本竞争、提交事实和资源生命周期这些通用机制。测试使用临时文件、可控注入端口和隔离子进程，未调用模型、外网、真实桌面或付费评测，也没有加入 benchmark 题目分支。修复验证不能替代 ScriptAct 与 Codex 等 agent 的公平评测结论。

## 逐项修复与合同差量

| 审核项 | 处置与最终行为 | 关键实现 | 回归与边界 |
| --- | --- | --- | --- |
| M1 / F04 大文件 expected 丢失 | 局部修复。计划增加临时 `baseBytes`，提交总是带存在性/原始字节前置条件；是否能保留撤销副本独立决定 | `files/utils/plan.ts`、`files/utils/batch.ts`、`files/types/edit.ts` | 32 字节小文件是原保护反证；超过 2 MiB 撤销预算的文件现在同样拒绝准备后的外部修改，外部内容保留。撤销预算不再决定写保护 |
| M2 / F03 undo 当前授权缺失 | 局部修复。撤销前对每个原用户路径调用当前端口 locate，核对真实 target 身份，再读取、验证、提交 | `files/impl/FileOperations.ts`、`files/contract/requires.ts` | 已知有效 changeId 加拒绝旧路径的新端口不能撤销；每次重建但仍授权同一路径的端口可以撤销；符号链接改向拒绝。合同采用**当前路径授权**，并未引入独立 session/owner 身份隔离 |
| M3 / F03 sandbox ID 与项目作用域脱节 | 局部重设计端口协调。所有已知 ID 的 diff/run/apply/discard 都先获取记录并以当前项目重新授权 source；apply 使用与 project 编辑相同的写门 | `project/impl/operations/ProjectCapabilityPorts.ts`、`sandbox/contract/requires.ts`、`sandbox/impl/LocalSandboxHost.ts` | B 项目操作 A 的有效 ID 全拒绝；同项目允许；排队期间取消不调用宿主；不存在的 discard 幂等。权限条件是已知有效 ID、共享宿主或记录目录，并非无 ID 即可越权 |
| M4 / F05 准备后取消仍开始动作 | 局部修复跨域提交边界。files/sandbox/project/memory 的内部端口接受可选 AbortSignal，准备/等待返回后和首次不可逆提交前再核；computer 可用性检查后再核；Office 统一发布前再核 | files、project、sandbox、computer、office、memory 的操作与提交 helper | locate/diff/ensureAvailable/验证/文档准备时取消都阻止新提交。files 已完成首项而下一项取消时保留部分结果；project 已提交后取消保留回执；sandbox 首次提交后完成已进入的提交段并报告实际路径 |
| M5 / F07 Office 排他输出只在准备时检查 | 局部修复。所有引擎先生成到临时内容/暂存文件，再统一发布；overwrite:false 用排他 link，overwrite:true 用同盘 rename，并重新核对根与真实 target | `office/types/output.ts`、`office/utils/paths.ts`、Office 各操作类 | write/copy 两条路径都覆盖“准备后目标出现”；同路径竞争恰有一胜；显式覆盖、取消、链接改向均有回归。允许覆盖的语义仍是显式覆盖，没有声称具备外部编辑者参与的版本 CAS |
| M6 / F06 提交后 hook 丢原错与恢复身份 | 局部修复。AfterApplyEdit/AfterRollback 失败成为结果 notes 与日志；模型回执保留 transactionId/changeRef/实际变更。清理按事务真实状态，只丢弃尚未提交事务 | `project/impl/kernel/LocalProjectKernel.ts`、`project/utils/agent/edit-commit.ts`、`project/impl/operations/ProjectFileOperations.ts` | AfterApplyEdit 抛错仍能 inspect/undo；BeforeApplyEdit 失败零写入且原错保留；AfterRollback 失败仍交出已撤销事实；回执窗口投影失败不覆盖提交身份。自定义宿主在已提交后抛错时，包装错误保留原 code/message/cause 和恢复引用 |
| M7 / F10 模型面批次/审批承诺失真 | 局部修复 TS AgentView、模板、README 与不变量。说明整批规划与逐文件原子提交的区别，写明部分完成、撤销身份与冲突条件；sandbox apply 说明符合实际调用行为 | `files/types/files.ts`、`files/impl/FileOperations.ts`、`files/template.js`、`sandbox/impl/SandboxOperations.ts` | source 与生成物一致性由主任务统一 generate/check 验证；故障注入覆盖真实部分提交。危险 sandbox run 的审批边界保持明确 |

M2 的授权合同尤其需要准确理解：默认本机 files 允许全机路径，受限 FileSpacePort 可通过 locate 约束当前授权范围。本轮保证旧 changeId 不能绕过当前 locate 或改向真实 target；若两个调用者都获准同一路径，二者并不因 session 不同而被隔离。没有增加脆弱的“端口对象引用即 owner”绑定。

新增公开返回字段：Project apply/rollback/undo 的 `notes?`，MemoryEntry/MemorySaved 的 `revision`。Memory save/remove 新增可选 `expectedRevision`。领域取消信号位于内部宿主/执行合同，不进入可移植模型输入。已有宿主可忽略新增可选参数，但要实现完整取消保障必须把信号传到实际提交点。files 的底层原子写入/删除信号最终贯穿由执行组补齐，详情见其提交边界报告；本组没有改写该组接管后的实现。

## sandbox 暂存竞争的追加修复

独立复核发现：原代码在初始源冲突检查之后还有 copyFile 暂存；此期间外部改写源文件会被后续 rename 覆盖。独立红色探针见 `.velaros-workspace/bench/foundation-fixes-53/execution/domain-staging-probe.mjs`，其旧构建结果由执行组留档。

当前 `sandbox/utils/mirror.ts`：

1. 镜像 diff fingerprint 纳入变化条目的内容/权限版本，避免仅靠路径、大小、时间等元数据。
2. 捕获源与镜像版本；完成全部暂存后再次核对源祖先、源冲突与内容版本，同时核对暂存内容与镜像仍一致，并重新核对已审阅 diff 指纹。
3. 每个 rename/unlink 前再次检查当前源，跨设备 fallback 复制后也再核。首次提交前最后一次异步检查返回后再次核 signal；首次实际提交之后按照真实已提交列表收敛。
4. 冲突在任何提交前发生时交回 not-applied；中途失败保留 applied 路径。暂存目录照常清理。

`sandbox/test/foundation-staging.test.ts` 在独立子进程中注入 copyFile/mkdir：源改写、镜像改写、暂存内容篡改均拒绝且原源内容保留；正常对照仍成功；首次 rename 之前 mkdir 返回时取消也拒绝。取消追加用例先红后绿（4 pass/1 fail → 5 pass/0 fail）。

这仍不是操作系统原生 compare-and-swap：最后一次比较与 rename/unlink 之间存在窄窗口，外部不遵循项目写门的进程可能插入。当前保护解决了可控、较长的异步暂存窗口，并对变化文件增加流式散列 I/O；没有声称跨任意外部写入者实现完整事务隔离。

## Office 多产物事实

LaTeX 转 PDF 先写出 `.tex`，随后编译和发布 PDF。此前 PDF 阶段失败可能被归类为整次 not-applied。本轮将 temp 目录分配及后续步骤纳入已提交后的错误包装，保留原错误 code/message/cause，并以 `executionOutcome: applied`、`applied: [source.path]` 点名已写入源码，明确 PDF 尚未完成。

两个通用反例覆盖源码写入后取消和 PDF 目标抢先出现；两者都先红后绿。转换器使用注入假实现，没有调用外部 LaTeX 工具或网络。发布后的回执不再依赖一个可能取消/失败的异步 stat，避免把成功发布误报失败。

## 浏览器 R2：超时与实际动作的生命周期

保留按 session 排队，但局部重设计超时隔离。`BrowserSessionActionQueue` 的调用超时不等于动作实际收束：动作仍在运行时将该 session 失效，取消排队者，同一资源身份不能普通重入；实际动作结束才释放占用。其他 session 仍可继续。

`ElectronBrowserRuntime.closeSession` 直接失效队列并摘除/销毁资源，随后有界关闭协议，不再排在悬挂动作之后。`assertAvailable` 位于资源获取/挂载和异步返回后，阻止旧动作把晚到 launcher 或 driver 结果装回新资源。

`BrowserProtocolSessions` 为 opening 引入世代，close 可使 pending opening 失效并立即允许生命周期关闭；旧 opening 迟到时关闭旧 channel，不覆盖新的 channel，也不删除新 pending；dispose 后可按合同重新使用。协议关闭有时间上限。

验证使用队列、channel、launcher 的可控假实现：超时不重叠、clear 取消排队、独立 session 恢复、晚到挂载拒绝、pending open 关闭、旧/新 channel 隔离、dispose 后复用。真实 Electron/CDP 资源销毁和已经送出的页面/操作系统动作仍需真机验收。队列无法撤回已经被外部系统接收的动作，不以超时假装撤回。

## 记忆 R3：可检测过期写

保留“一条 Markdown 一次整条替换”的存储与默认语义，不擅自改成正文合并：省略 `expectedRevision` 时最后成功提交者覆盖；省略 tags 时在锁内保留最新 tags，传 [] 清空。list/save 返回原始持久内容的 revision；save/remove 传该版本时只修改该版本，过期报 CONFLICT；null 表示要求不存在。

`withMemoryWriteLock` 用同目录每 id 的排他锁目录协调不同 store 与进程，锁内重新读取、核对 revision，再原子发布或删除。锁冲突立即可见，不无限排队。取消在准备和 rename/delete 前复核。包 consumer 测试实际使用返回 revision 成功 CAS，再用旧版本验证拒绝，未仅忽略新增字段。

版本保护适用于采用该协议的写入者；手工编辑器不参与锁协议。进程异常退出可能留下锁目录，当前明确失败并要求确认写入者状态后处理，未按不可靠超时自动抢锁。文件格式兼容旧条目，revision 不写成额外头部字段；它由实际内容计算。

## 验证记录

证据根目录：`.velaros-workspace/bench/foundation-fixes-53/modules/`。各批次存在重叠，不把数字相加充作独立测试总量。

| 证据 | 结果与用途 |
| --- | --- |
| `red.log` | 主缺陷类最初 1 pass / 12 fail；通过项为小文件既有保护对照 |
| `green-expanded.log` | 主缺陷类扩展 22 pass / 0 fail |
| `related-final.log` | 相关已有回归与新增回归共 152 pass / 0 fail |
| `secondary-red.log` | 浏览器/记忆初始反例 0 pass / 5 fail |
| `secondary-final.log` | 浏览器队列/协议、记忆跨 store/跨进程 CAS 共 17 pass / 0 fail |
| `memory-acceptance.log` | 行为验收 12 pass / 0 fail；当时 5 个依赖生成物测试被明确过滤，后续全域验收由根任务负责 |
| `office-partial-red.log` / `office-partial-green.log` | LaTeX 后续失败真实副作用 0/2 → 2/0；绿色批次中 consumer 被 test name 过滤，未算通过 |
| `staging-consumer-green.log` | 初版四种 sandbox 暂存场景与真实 memory dist consumer 共 5 pass / 0 fail |
| `closure-green.log` | 本组最后一批混合收口 46 pass / 0 fail，含 sandbox 全部旧回归、office/project/memory/browser；其后仅追加首次提交取消用例 |
| `sandbox-boundary-red.log` / `sandbox-boundary-green.log` | 最后一次异步复核后的取消 4/1 → 5/0，包含三种暂存漂移及正常对照 |
| `integration-regression.log` | 统一集成暴露的两项验收收口后 39 pass / 0 fail：Office 全验收、sandbox 全验收、暂存五场景；保留旧安全断言并加强 LaTeX 已提交事实的磁盘验证 |
| `integration-lint.log` / `integration-style.log` | 本次集成补丁 scoped lint exit 0；arch-guard 37 checks passed；不以其代替全库最终门禁 |
| `typecheck-final.log` | 中期 velaros 源码类型检查 exit 0；最终统一构建/类型检查以根任务最新流水线为准 |
| `style-final.log` | 中途 scoped style 快照，曾剩两个 memory optional 类型写法；已改 LooseOptional，最终 style 由根任务统一重跑 |

files/core 原子暂存 fsync 后取消的独立反例与修复由执行组负责；其测试不可被这里较早的绿日志替代。生成合同由根任务执行，未手改 surface。`git diff --check` 在本组源码冻结时通过。所有最终集成状态应引用主任务冻结后流水线，而不是本报告的中期日志。

集成验收补充：新增镜像内容指纹会在正式暂存之前读取不可读文件，原先仅覆盖暂存循环的错误包装因此漏掉了已知“没有提交”事实。当前 LocalSandboxHost 的提交前阶段和 applyMirrorChanges 的全部预检都保留 not-applied，包装同时保留原 context 中的冲突详情；进入真实提交后沿用实际 applied 列表。Office INV-18 从“转换后不标”细化为“已知 LaTeX 源码写入则明确 applied，未知外部效果保留未知”，用源码内容、已提交路径、PDF 不存在与原转换错误码四项共同验收。记忆和浏览器不变量所引用的新测试需在包 test 命令显式登记，由根任务统一补齐；门禁规则没有放宽。

## 覆盖矩阵与保留边界

| 模块 | 处置 | 已核验范围 | 未验证或宿主责任 |
| --- | --- | --- | --- |
| files | 保留引擎，局部修复 | 大小文件版本、当前授权撤销、链接改向、准备/逐项取消、部分事实、已有编码/批次回归 | 任意外部进程最后 compare/rename 窄窗口；全机路径授权仍由宿主策略决定 |
| project/code | 保留事务引擎，局部修复 | 已提交 hook/notes、before hook、取消、回执/撤销、sandbox 写门；已有项目相关测试 | LSP、多语言质量、所有持久层崩溃恢复矩阵未做真实环境压力验证 |
| sandbox | 生命周期授权/协调局部重设计 | 已知 ID 跨项目拒绝、当前项目允许、全旧 sandbox 测试、三类暂存漂移、首次提交取消 | 原生文件系统 CAS、独立外部写入者、各 OS confinement 全矩阵、run/apply/discard 压力矩阵 |
| office | 统一提交局部重设计 | write/copy 排他、竞争、覆盖、链接改向、取消、Word/PPT/Excel 等已有生成测试、LaTeX 部分事实 | PDF/LaTeX 外部工具、所有渲染版式和真机预览仍未执行 |
| computer | 局部修复可用性后取消 | typeText/key 注入端口调用数为零 | 真机权限、多屏/DPI、sidecar 与已发送输入不可撤回 |
| browser | 超时与拆卸局部重设计 | session 串行、失效、关闭、迟到结果、协议世代的假实现验证 | 真实 Electron/CDP/登录/下载/资源销毁 |
| memory | 保留格式，扩展版本协议 | 过期 save/remove、expected absence、跨 store/跨进程 CAS、默认覆盖/tags、取消、dist consumer | 手工外部写、异常退出残留锁处理、外部符号链接恶意竞争 |
| shell | 保留 | 审核过 prepare/spawn 取消与 confinement 合同；本组无产品变更 | 项目 cwd 不等于 OS 隔离；真实进程树回收、交互终端和宿主默认装配 |
| images | 保留、抽样 | 合同/模板、路径与大小边界、附件通道、逐图取消 | 生成模型、sips、多帧和模型视觉实际输入 |
| web | 保留、抽样 | 端口、临时页面 finally 关闭、搜索/读取/降级合同 | 真实搜索、网络、重定向与宿主隔离 |
| sessions | 保留、抽样 | 宿主注入、ask/tell/list、signal、execute-only 效果 | 实际跨会话权限、循环等待、公平性与排队 |

这些边界是当前覆盖范围和合同限制，不能转换成“已验证所有平台与所有工具”。下一阶段批量诊断应继续按通用缺陷类补真实环境矩阵，并预先冻结正式评测题集、评分与运行条件。
