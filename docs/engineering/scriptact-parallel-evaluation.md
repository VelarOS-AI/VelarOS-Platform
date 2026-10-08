# ScriptAct 并行评测环境与修复循环

第13道固定开发题Flipt（X）已完成并结算，按用户要求暂停。双方官方reward=1；ScriptAct/Codex解题999.602/1080.342秒，ScriptAct快7.47%；完整attempt1275.247/1411.205秒，快9.63%。参考费ScriptAct完整$1.869456，Codex已知$1.6896304另2笔未知；完整费用比较与实际扣费未知。84新增请求全部物理结束，旧3205条/148未知完整保留，累计3289/150。四阶段租约、批次准入、容器、控制器85975和采样85976已释放或退出，子agent均已停止。报告 `analysis-54x/REPORT-v1.md`、汇总SHA `767850b2180da9fa3011506ea3e9f29b75691ca515e2d4e38ea9acc3d1e4f724`、根结算SHA `8f73f38f9e811f2ee3d6f0a62aa746989cbf775e1e7dc9d86383a0f9efea5eb4`。

X完整轨迹显示SDK等待343.756秒、14脚本648.989秒；最长定向Go测试473.725秒正常结束。28底层操作为shell12/read12/edit1/describe1/release2，全部返回成功，命令3次语义失败。Codex外层65状态unknown、原生命令25（8非零）及文件修改6；重叠期间实际有修改与重验，3次主动Ctrl-C已核对。ScriptAct第11轮明确被CONTEXT_REQUIRED阻塞；跨直接页与嵌套部分页的完整范围在历史重组后仍可能欠账，私有证明与生命周期接点尚未零模型复现，保留为待确认问题。16帧segment1/volumes0，重组不是fold。当前等待用户恢复。

第 12 道固定开发题 Proton（W）已完成并结算，双方官方 reward=1。ScriptAct / Codex 解题 **634.993 / 604.879 秒**，完整 attempt **1123.526 / 1092.740 秒**，ScriptAct 分别慢 **4.98% / 2.82%**。参考模型费为 ScriptAct 已知 **$0.652084**另 1 笔未知、Codex完整 **$0.8559144**；完整费用比较与第三方实际扣费未知。48 条新增请求全部物理结束，原3157/147全行及旧文档投影保持，累计3205/148；控制器75500/采样75501退出，四阶段租约、整批准入与容器已释放。汇总 `analysis-54w/paired-summary-v2.json` SHA `9dbf671d0713c2737ff4229daf8c094b625f354b48a5c5597ac6218a4f7e2459`，根结算 SHA `90e443db7e43316875013854dc0547c5cebced2c8ce1f05cddfa8bb82b4417f9`。

W完整轨迹：ScriptAct SDK等待272.227秒、9脚本346.959秒（1个超原始采集预算的PROGRAM_ERROR），19kernel为shell16/describe1/read1/edit1，底层返回全部成功、命令3次非零。Codex外层exec36状态unknown、原生命令30（4非零）/文件修改1；重叠143.236秒主要包含轮询，不能直接归因提速。后台/异步与输出筛选合同已实际展示；本题无嵌套页修复触发。一次HTTP200体流ECONNRESET用量未知，同Node67秒静默/心跳对照均通过，真实生产原因仍未知。独审确认后台success文案把启动与执行完成混淆，已最小修正手写源并正式生成声明；7项相关Shell回归、生成器、所有权、Node24正式构建与候选独审均通过。行为、采集上限和模型配置保持；W未使用后台任务，本修复的整题提速尚未知。第13道固定开发题Flipt的21层镜像导入与实际glibc环境检查均通过，所有准备容器及维护资源已释放，零模型请求；X正式配对已完成结算，当前按用户要求暂停。

X使用冻结候选 `bundle-foundation-54x-sol`，指纹 `95ea3a0a1baf2befb9ca05e66727d681df05c4df79b8f361f3de612bdc54073e`；清单SHA `f65946d879fbe43f7556ae014c1057dd273ac21c2f694e84a1c9e42dfaef05dd`、执行计划SHA `144255cfe74171bfe89e32dfedacfe978b8373a234745e1365cb382339febbce`。实际glibc环境、双方安装、零模型官方Oracle、宿主构建与独审均通过；本轮后台合同修复未触发，不能归因整题提速。已完成冻结输入保持，运行状态入口 `parallel-54/active-campaign.json` 已记录用户暂停。

第 11 道预登记开发题 Tutanota（V2）**双方官方 reward=1，已完成并结算**。ScriptAct / Codex 解题 **429.067 / 490.365 秒**，完整 attempt **606.039 / 658.849 秒**，ScriptAct 分别快 **12.50% / 8.02%**。ScriptAct 参考模型费已知 **$0.7965536**、另 1 笔未知；Codex 完整参考费 **$1.1700136**。完整费用比较未知，第三方实际扣费未知。一题开发成绩不能证明总体领先，当前嵌套材料修复在该任务中 `trigger_not_exercised`，不能归因提速。完整轨迹与分层统计见 `analysis-54v2/REPORT-v2.md`、`paired-summary-v2.json`，汇总 SHA `91884e148dcd620795f305e418a459252799d7b8a174754a07bf31cd3653bf3f`。

完整原始材料通过有效嵌套读取页交付、但原材料 required 缺口仍未解除的问题已复现并修复；沿不可变宿主签名页逐层核验，保持展示预算、缓存断点与完成标准。完整上下文模块 121/121（含专项 17 项）、其他 Runtime 592/592、Provider/MCP/计量 40/40、轨迹与报告 67/67，共 820 项不同检查通过；5 项同输入实际 Runtime 对照中，完整嵌套材料缺口 1→0，裁剪、无签名、跨会话与重置负例仍正确阻塞。全上下文补验在配对启动后由宿主零模型执行，独立凭据保留时间边界。候选验收 `candidate-54v-preparation/root-validation-v2.json` SHA `cf13b984958dd25300d9f3ba2da57a0244a87d15dd5dd686ec300cdb4c9b3634`。

全 46 条新请求物理结束，原 3111 条/146 未知全行及整文档投影保持，累计 3157/147；旧网关 53/0 保留。四阶段租约与整批准入释放，控制器 54644、采样 54645 退出，容器、在途与队列为 0。根结算 `settlement-audit-54v2/root-validation.json` SHA `9781441707e1e9d865cb1776281e1d13f7b3f02c214b91dc01c85f16bcbd4817`；四个主容器 Docker 配置均 1 CPU/4 GiB，配置证据不能表述为 kernel 配额证明。

真实轨迹暴露通用观察器问题：Codex 普通诊断文本夹在 JSON 事件中时，旧索引变成 partial。独审定位原生 session 首行显式 thread 与 payload.id 冲突可 false complete，已补修所有行的一致性。20 项读取器、7 项消费测试、4 组独审边界及所有权检查通过，真实 V2 正式索引 complete；新版完整 report 与原 report 字节相同，诊断与错误保留。根集成 `analysis-54v2/codex/evidence-index-repair/root-integration-v3.json` SHA `0b6e3d4db02c0ab5266b3cf420c3811314cfd3980f7fec4a133ff9a85c38a773`。**W 配对已通过正式环境准入并完成结算**，已完成成绩保持。原始日志、旧 partial、新回放和全部失败凭据分版本保留。

第 12 道冻结开发题为独立 Proton 任务 `caf10ba…`。精确镜像 `326504a…` 已导入，26层及diffId验证；实际 `/bin/sh` ELF PT_INTERP 证明 musl。首次容器创建约119.786秒，旧60秒客户端超时后daemon仍迟到完成；精确never-started容器已清理并正式结算。通用准备器将create限定600秒、其他元数据60秒，TERM转取消保留未知effect阻塞，17回归与5独立边界通过。419个已终态历史JSON透明无损压缩，原路径完整字节/SHA保持，观察宿主净增约2.01GiB；全部执行记录、账本、恢复压缩层保持。第三次正式环境发布 `execution-v3/result.json` SHA `40c9f795414bf393e7187d1937d1ef20032df5ef64e9ac9f77d6b9cb528352bf` 已通过，宿主25.95GiB/VM29.67GiB，24GiB标准不变，模型新增0。候选W复用V产品并绑定修复后观察器与准备器，`candidate-54w-validation/root-validation-v2.json` SHA `9be2d950c475840100cfe47c734ac1f00b2acb0deb499d409697c8bc0a8a7d8a`；双方安装、零模型官方Oracle及新冻结准入均通过，W源任务与官方重放已结算，旧失败凭据全部保留。

通用冻结器绑定 376 个 installed Harbor 源码与运行资产，覆盖实际资源生产、策略、factory/trial 和 Compose 合并链。V2 正式清单 SHA `9bc90ab2640052b7354cbced0bd23d81801f867019d1afa5b1318a9bd7d1a29f`，执行计划 SHA `0c694e65ee6210dac9a3d32fd016d3f5a56f456c3d325476c63584797e269342`；启动验收 SHA `1d86ee9b40934f8ccffdd166a338df4da3adafdc3c0f4297d299ebf14bfecb66`。下批按修复后读者与实际环境冻结新身份，已完成冻结输入保持。

优化按稳定性、官方质量、端到端时间及完整费用验收；请求数量、上下文、缓存和各层工具/模块计数用于诊断。ScriptAct 外层 API 工具 0、Runtime 脚本 9（1 失败）、kernel 35（shell32/memory1/project2）、命令非零退出 2；Codex 外层 exec34（该层状态未知）、原生命令26（3失败）、文件修改5成功，exec 正文中静态操作名出现数另列，不能将不同层相加或直接排名。两次 ScriptAct 约65秒等待有持续模型输出，另一次预响应连接重置用量未知；生产断流仍未完整归因。独立验证保持隔离，实况见 `.velaros-workspace/bench/parallel-54/active-campaign.json`。

2026-10-01 及此前已完成的官方配对与修复记录如下。

U 的同一道 Element Web 再验证已完成并结算，双方官方 reward=1。ScriptAct / Codex 解题285.998 / 286.956秒、完整attempt404.053 / 404.102秒。ScriptAct参考模型费$0.655288完整，Codex已知小计$0.2188448另1未知，实际费用未知；累计账本250/13、四阶段物理结算、资源释放、控制器及采样退出。ScriptAct相对T2输入−17.07%、参考费−12.08%，自身却慢12.485秒；本轮未触发旧大正文缺口路径，双方有transport恢复，不能归因提速或证明整体领先。报告 `analysis-54u/REPORT.md`、汇总 `analysis-54u/paired-summary.json`，实际状态见 `active-campaign.json`。

历史七批的精确题目不同，ScriptAct 相对耗时差为 −87.154、+66.275、+903.189、−19.126、+20.016、+90.392、+100.854 秒，不构成同一题目的版本退步曲线。需补持续的固定代表任务版本性能回归；当前实际瓶颈与历史差值的因果关系分别验证，开发题不支持整体领先结论。历史审计 `analysis-54t2/progress-audit/`，本轮修复及验证说明 `core-context-proof-repair-54t2/REPORT.md`。

验证修复周转优化已完成并通过独立复核：70 项集成检查通过，四组同输入验证 5.127→0.177 秒；R/Q 完整自动诊断每批约 0.224/0.251 秒，同输入产物可复用。验收 `throughput-optimization/final-validation.json`，SHA `b5688784f3e0543476be226787b6c4da7004742ecb8db4bcad53cde38662411a`；独审 SHA `9cf50a0d537cd16dc40a43da8552f930e133cfc77aa94d3261c4de5aa50fb812`。本轮源任务终态将自动生成完整诊断，控制器终态再刷新结算后的诊断。

核心链路与实测费用拆解见 [Platform 运行主链](../architecture/platform-runtime.md)。Q 正式构建及 Runtime/Act 622/622、Model 180/180、Agent 40/40 回归通过；`parallel-54q` 官方重放双方得分 1，源任务、重放、账本与资源已完成结算。

第 7 道固定开发题 Vuls：ScriptAct / Codex 解题 **325.514 / 355.544 秒**，派发至官方重放清理结算 **427.745 / 454.652 秒**；已知参考小计 **$0.5800784 / $0.4560336**，Codex 一笔未知用量，完整费用比较和双方实际扣费未知。28 条签名请求物理结算，原 138 条及 11 条未知保持，累计 166 条、12 条未知。Codex 一次 ECONNRESET 的上游生命周期约 65 秒，客户端在 14.812 秒断开，后续请求与旧生命周期重叠；不能据此推断 65 秒客户端等待、直接扣除时间或证明核心提速。最终对账 `settlement-audit-54q/final-settlement.json` SHA `700970c047b0fbe8435e9fa13fce44c67bc6fbd903c650f7fa2490a3df124c6b`。完整轨迹核心诊断已封存；R 依据通用 Shell 生成盲点修复并封存，固定开发题第 8 题 Navidrome 配对已完成。

固定开发题第 8 题 Navidrome（R）已完成，双方官方 reward=1。解题 226.953 / 206.937 秒，完整 attempt 355.544 / 329.321 秒；完整模型费参考估算 $0.3147728 / $0.2840648，第三方实际扣费未知。22 条新请求物理结算，历史 166/12 逐字保留，累计 188/12；控制器 69336、采样 69337 均退出，租约、容器与上游队列清空。根结算 SHA `a62faf7c793a280fcc5bdf1c2a5a32525d27b713454aa25eb5f3b6a5ed8acbb8`。完整轨迹诊断及增量当前帧计量修复已完成，原判分、耗时、费用和身份字段保留。

当前优化围绕 ScriptAct 的完整执行链与缓存断点共同展开，以稳定性、官方任务质量、端到端时间和完整费用验收。拆解模型等待与生成、脚本执行、工具 I/O、有效材料交付、整理与恢复的关键路径；读写 token、上下文及工具/模块调用分层用于诊断。验收口径见 [ScriptAct 与 Codex 验收口径](scriptact-acceptance-criteria.md)。

当前新批次统一使用用户选择的 **`gpt-5.6-sol / high`** 和上游 **`https://ai.hedgeho9.cn/v1`**，双方同时使用相同模型与资源。第三方实际费率未知，官方价只作参考估算，模型和价格依据在 `.velaros-workspace/bench/parallel-54/model-selection.json`。

候选 **Q 已完成核心修复、正式回归和独立产物核对并封存**：`bundle-foundation-54q-sol`，指纹 `a4c92148d34802db2593ceb6c609d207d0eec8649649a5d7b1a3f8a646b1f3dc`。当前状态增量、原预算内批量交付、真实历史重置恢复、断点位置及原生接口兼容修复通过，ScriptAct 生成指导沿已有程序引用与精确编辑合同维护。Runtime/Act **622/622**、Model **180/180**、Agent **40/40**、Script 输出 **50/50**；计量和报告完整 **102/102**、最终受影响 **41/41**。3,954 文件封印、3,915 正式 dist、glibc/musl 归档逐字核对；全局代码风格保留 29 个既有错误，本轮新增错误 0，整体该门禁仍未通过。候选总验收 `repair-integration-54q/validation.json` SHA `db3708c725b5e5c9cba3b49a9356309d1bbcd7c1a8d8efe5c7cdc102c31afb2c`。当前配对为固定开发序第 7 题 Vuls（musl），Q 清单 SHA `c9de93555bf65541c62e37640bec5f25a59638de85f5d8659cbf953dbbc428f8`。双方安装、零模型官方 Oracle 及完整启动验收通过；启动验收 `validation-54q.json` SHA `3aa4dcacd8a38b97c5a9dbc6666875eb74ff197fc95034a0002f4d98b92ceeca`。控制器 **57725**、资源采样 **57726** 已退出，实际每槽 1 CPU / 4 GiB、最多两槽；四组 source/replay 租约及整批准入已释放，容器、在途和队列为 0。VM 容量恢复独审通过，保留全部原轨迹、缓存与请求；修复及环境验收零新增付费请求，启动账本基线 138/11。实时状态见 `active-campaign.json`，官方重放、结算与完整核心诊断已完成，R 已通过环境与启动准入并进入 Navidrome 配对。

候选 **O 已完成通用修复并封存产品包**：`bundle-foundation-54o-sol`，指纹 `4465fe78affb33da2bc1075090312c5979d51cbe742000a991d566e5d65216e6`。修复包括：预算头变化导致已在历史交付的相同块重发；压力整理已写好同卷叙事后，排队的自动整理重复分配模型；Codex 中断后的旧累计用量被转换器再计一次。Runtime **181/181**、计量与报告 **74/74** 通过，共 255 项；新增用例已包含在这些数量内。Codex 原生记录只读复算的已知参考小计由 $0.4921736 校正为 $0.4689144，完整费用仍未知，原始轨迹、官方成绩及账本保持。3,954 文件封印、3,915 dist 文件核对通过，相对 N 仅 Runtime 14 个产物变化；模型、默认预算、缓存策略和依赖锁保持。本轮新增付费请求 0，累计 127 条请求与 11 条未知用量逐字保留。总验收 `repair-integration-54o/validation.json` SHA `2c371ce83a3866595d52348d20b1456c2ae905aaf5ebeb2a5df2d98c509274e5`。

`parallel-54n-v2` 固定开发题序第 6 题 NodeBB 已完成：ScriptAct / Codex 官方 reward **1 / 0**，请求 **19 / 15**，agent 执行 **729.889 / 491.761 秒**，派发至官方重放清理 **797.711 / 559.772 秒**。已知参考估算 **$1.6364496 / $0.4689144**，另有 **3 / 2** 笔未知用量，完整费用及实际扣费未知；结果质量不等，不作等质量成功效率比较或总体领先结论。34 条新请求均终态，原 93 条及 6 条未知逐条与原始副本一致，累计 127 条、11 条未知。控制器 54114、采样 54115 已退出，四个 source/replay 租约与完整 batch epoch 已释放，容器、在途及排队均为 0。根对账 `settlement-audit-54n/final-settlement.json` SHA `bfc62a6553ec575de7f1e58447ff4bebdf420208124c332cbcfadd5270277076`。完整轨迹诊断在 `context-audit-54n/` 与 `latency-root-cause-54n/`，先完成通用问题审计和修复再派新批次。清单 SHA `c50b13cf2ee9169fa8361bab36378928f34e9eb061dc07c95d8b9a8ba67a7d67`、候选 N、v7 历史与独立隔离保持，启动验收 `validation-54n-v2.json` SHA `b8119f87bcb3644547469374e86d701bf8f7461ea14460b2d2f98fd839f21209`。

`parallel-54m` 固定开发题序第 5 题 Ansible 已完成，双方官方 reward=1。ScriptAct / Codex 请求 **12 / 10** 次，解题 **454.613 / 318.108 秒**，派发至官方重放清理 **881.595 / 747.947 秒**。已知参考估算 **$1.0164184 / $0.2676536**，双方各一笔中断用量未知，完整参考总费用与实际扣费未知。本题 ScriptAct 仍慢，不能作为整体领先的证据。22 条新请求全部终态；原 71 条请求与 4 条未知记录保留，M 结算时累计 93 条、6 条未知，当时容器、租约及在途请求为 0。最终结算在 `latency-root-cause-54m/final-settlement.json`，完整分析在 `latency-root-cause-54m/FINAL-LATENCY.md` 和 `context-audit-54m/REPORT.md`。

修复候选 **N 已封存并通过验收**：`bundle-foundation-54n-sol`，指纹 `d87dde93272f81bb269d645d5e9d02130f3ce88418133bfcc725ea703055b846`。完整历史已交付的原始输出按块去重；宿主验证的读取页使用紧凑无损编码；控制器、repository launcher 和镜像准备接入共享持久 worker 准入。同输入本机 HTTP 对照中重复原文 2→1，当前结果 17,680→333 字符；高转义页完整交付 0→1。正式 Script 154、Runtime 输出/上下文/轨迹 108、Runtime/System 93、独立产品 9、基础设施 127 与独立基础设施 32 项通过，各组有重叠。3,954 文件封印、3,915 dist 对照及 glibc/musl 归档通过，相对 M 仅 Script/Velaros 21 个产物变化；默认预算、缓存策略、模型与依赖锁保持。修复付费请求 0，原 93 条请求及 6 条未知用量保持，租约、容器与在途均为 0。总验收 `repair-integration-54n/validation.json` SHA `94e1049f6d3ff05ebb152bb9516c7a28a51ce6e725a4c85081bdfaa52abd11dc`，报告 `repair-integration-54n/REPORT.md`。

固定开发题序第 6 题 NodeBB 已完成官方镜像与 glibc/amd64 环境准备；暴露快照 v6 含 287 条观察，保留全部历史与独立验证隔离。N 清单已冻结，SHA `ef6bd213192abf8c0123e1377c20da2ec4bb0156adb434be07ad88d78d8f889c`，包含正式 `repository_oracle.py` 与共享准入 helper。新 Oracle 检查精确任务/结果身份、严格零请求账本，明确已知失败清理后释放和未知状态保留；24 项专项、53 项共享回归及 9 项独审通过（覆盖有重叠）。双方零模型安装通过；首次官方 Oracle 在环境启动阶段因宿主 health 配置被过滤而失败，尚未执行解法或判分，原失败、零新增请求与已清理资源证据保留在 `oracle-barrier-repair-54n/root-failed-preflight-settlement.json`。宿主 health 桥接现已修复，59 项回归与 4 项独立实际屏障检查通过（有重叠）；新 N-v2 已通过两次安装、零模型官方 Oracle 和根验收后启动配对。专用 VM 的已释放块经维护准入执行 fstrim，宿主可用 23.826→51.403 GiB，21 个镜像及 layer、账本93/6逐字保持；证据 `host-capacity-recovery-54n/result.json`。整题请求、耗时和费用收益待配对验证。

本批补齐启动前磁盘准入：Docker 没有落实 `storage_mb` 配额，原调度器只检查 CPU/内存。新守卫按并发 attempt 分别累加声明需求，加固定 4 GiB 余量，核对专用 Docker/Colima 身份及 VM/宿主实际可用空间；本题双槽需 24 GiB。21 项离线边界与 9 项独立启动集成通过，失败均在派发前阻断。精确回收两张已完成的 Proton 历史镜像后，VM/宿主可用约 27.014/24.572 GiB，账本、镜像压缩缓存和全部执行记录保持。它是紧邻派发的保守空间快照，不是运行期磁盘配额。证据 `disk-admission/`、`preflight-54m/disk-gate-review-final.json` 和 `development-pressure-24/05-ansible/capacity-audit/`。 正式可复用 `scripts/agent/harbor/disk_admission.py` 已新增，23 项迁移检查和模块所有权检查通过；当前 M 使用已冻结启动守卫。共享入口已在 N 修复接入，验收与新 Oracle 迁移边界见 `pending-repairs-54m.json`。

修复候选 **M 已完成并封存**：`bundle-foundation-54m-sol`，指纹 `c719dd1a46081cb0ae4a5c10dc52d72d250950f0c2cdedb3d2b296595ae66559`。修复显式块预算未传递、部分历史遮蔽新增正文，以及完整历史被重复以较窄摘录发送的问题；实际选中模型帧新增宿主预算审计。默认预算、模型、缓存和运行配置保持。正式 Script 151 项、输出/上下文/轨迹 98 项、Runtime/System 93 项通过；独立 48 项构建矩阵、6 项实际 SDK 请求场景、6 项完整材料覆盖和 5 项兼容检查通过，各组有重叠。原 INV-53 测试和参数未改，受控诊断额外压力整理从 3 次降为 0，正常叙事仍为 2 次。

M 的 3,954 文件封印与 glibc/musl 归档通过独立核验，相对 L 仅 Script/Velaros 31 个包文件变化，3,915 个 dist 与正式构建逐文件一致。修复验收时新增付费请求 0，原 71 条请求及 4 条未知用量保持，控制器、租约、容器与在途请求均已收束。报告 `repair-integration-54m/REPORT-v2.md`，验收 `repair-integration-54m/validation-v2.json` SHA `2c9cd7f3d6230c20a926353f8c68753d7cc262bf172803862a1f92a34f49d459`，全部 59 个索引证据 SHA 复核一致。第 5 题最终配对结果见上文；跨题差异不能归因于单一修复。

`parallel-54l` 第四道开发题 OpenLibrary 已完成，双方官方 reward=1、原生完成。ScriptAct / Codex 请求 **14 / 20** 次，解题 **458.341 / 437.909 秒**，派发至重放清理 **535.614 / 518.491 秒**。已知参考估算 **$1.1213504 / $0.4370648**，双方各一次 HTTP200 后 ECONNRESET，各一笔未知用量，完整参考总费用与实际扣费均未知。请求少 30%，本题耗时仍略长；不能据本题宣称整体领先或把跨题差异归因于单一修复。34 条新请求全部终态、两方 source/replay 身份归账与清理通过，旧 37 条请求原文 SHA 重建一致。控制器 89373 与采样 89374 已退出，租约、容器、在途和排队请求均为 0。完整轨迹诊断与 M 通用修复已完成，下一批继续按固定开发题序推进。

L 清单 SHA `b460ffd35728e04da0720a1ce7781433cc36e2d62403686db12102b6b6076759`，启动验收 `validation-54l.json` SHA `e0acdc3d5fdda21ac9f2d89b53862e67d5a20be5b4b95a209af3631885908d9e`。官方 Debian 12 / amd64 / glibc 环境、双方零模型安装与 Oracle reward=1 验收通过，44 项独立身份核验通过。exposure v4 保留 K 新增 7 条观察及全部历史，独立验证集保持隔离。最终对账 `latency-root-cause-54l/final-settlement.json`，完整分析在 `latency-root-cause-54l/` 与 `context-audit-54l/`。

`parallel-54k` 第三道开发题 qutebrowser 已完成，双方官方 reward=1、原生完成。ScriptAct / Codex 请求 **6 / 9** 次，解题 **250.016 / 153.137 秒**，派发至重放清理 **318.844 / 220.470 秒**；参考估算 **$0.3521736 / $0.1765248**，本批 15 次均取得用量，第三方实际扣费仍未知。ScriptAct 请求更少，但耗时和参考费用更高。控制器 1357、采样 1358 均退出，源任务与重放身份、资源、清理和请求已对账；旧 22 条请求及两笔未知用量保持归属。

K 完整轨迹发现：ScriptAct 首段 5 次 Shell 读取成功后，output 将对象声明为 text 触发运行时类型错；下一段重读了相同 5 次输入，返回正文 SHA 相同。L 已针对这条通用预检和恢复链路修复并回归，保留 K 原始运行及分数。本题没有 required 缺口、memory 补读或新 read-proof 触发，不能用本题宣称该机制已经线上提速。

K 清单 SHA-256 `f09ea78b9564663a536625f6061c67f3c1ddba43b09fe92f39776a28ba2c70a2`，双方安装、官方 Oracle 和 28 项独立环境身份核验通过；首次 Oracle 日志重名失败发生在实际执行前，其回执和释放证据保留，健康验收绑定 `oracle-54k-v2.json`。入口 `active-campaign.json`，完整对账 `latency-root-cause-54k/final-settlement.json`，诊断 `context-audit-54k/` 与 `latency-root-cause-54k/`，启动验收 `validation-54k.json`。

`parallel-54j-v2` Flipt 配对已完成，双方官方 reward=1、原生完成，源任务与重放清理正常。ScriptAct / Codex 请求 **13 / 9** 次，解题 **726.855 / 199.761 秒**，派发至重放清理 **1098.314 / 548.823 秒**。已知参考估算 **$0.793556 / $0.2564568**；ScriptAct 另有两笔未知用量，完整成本与双方实际扣费未知。本轮 ScriptAct 更慢，请求也更多。22 条签名请求收束，控制器 99216 与采样 99217 已退出，租约、容器及在途请求全部清空。

完整 source 轨迹说明工作量存在差异：ScriptAct 同两包测试先超时 118.953 秒，再运行 179.133 秒发现漏导入，修正后 8.487 秒通过；前次编译可能保留缓存，不能将整段超时都当浪费。Codex 的同包验证在 gofmt 找不到时退出 127，没有真正执行 Go 测试。ScriptAct 还在 done 后因早期 required 正文缺口追加补读/释放；新候选 K 增加宿主来源回执，完整页真正送达后才能解除原引用缺口。成功请求的协议终端至传输结束累计仅 0.882 / 0.525 秒，本轮没有大尾流证据。

修复候选 **K 已封存**：`bundle-foundation-54k-sol`，指纹 `0d92bb6ce2428b060861f2f5881b3677d837777dab4d93a9d038e5629d3173e9`。已修补读来源证明与完成判断、登录后实际 PATH 报告、CR/Unicode 换行诊断，并明确前台超时与后台任务查询合同。正式 Script 135 项、上下文 120 项及另组 86 项、Shell 119 项、独立反例 19 项通过；各组覆盖有重叠，Shell 的 6 项 Windows 原生测试跳过。七包正式构建、生成合同、模块所有权和 glibc/musl 归档通过；3,954 文件封印，相对 I 仅 Script/Velaros 39 文件变化，依赖锁与运行配置相同。修复阶段新增模型请求为 0。K 本题配对结果与后续修复状态见上文。证据 `repair-integration-54k/REPORT.md`、`repair-integration-54k/validation.json`、`read-delivery-review-54j/validation-final.json`。

修复候选 I 的新 Proton 配对 `parallel-54i` 已完成，双方官方重放 reward=1、原生正常完成。ScriptAct / Codex 请求 6 / 20 次，解题 478.733 / 497.859 秒；源任务派发至重放清理结算均约 742.901 秒。已知用量参考估算 $0.1529856 / $0.3006048，另有 2 / 1 笔中断用量未知，完整成本与实际供应商扣费保持未知。请求少 70%、解题快 3.84%，端到端基本相同；这是单个开发题，不能作为整体领先或修复因果的证明。

正式完整轨迹与原生记录确认无重复补读、required 伪缺口或重复执行；中断帧零执行。ScriptAct 三次脚本、五次 Kernel 操作全部成功；Codex 外层 exec、原生命令和文件操作分别报告。两边都运行定向测试与包级类型检查，不能把 ScriptAct 的 195 秒长脚本直接归为框架缺陷。三条 HTTP200 后断流均在末字节后静默约 60–61.5 秒，跨参与方两次仅相差 6 毫秒，具体传输故障层尚未确定。

控制器 80582、采样 80583 均退出，26 条签名请求全部结算，三条未知用量保留，源任务及官方重放清理正常。当前入口 `active-campaign.json`，I 完整对账 `latency-root-cause-54i/`，上下文和工具审计 `context-audit-54i/`。零上游真实客户端 wire 参数和报告计时边界核对已完成。

计时报告现保留原 `end_to_end_seconds` 作为 trial 生命周期兼容字段，新增核验身份和清理证据的 `attempt_wall_seconds`；独立 54i 修订结果与派发回执逐值相同，89 项联合回归通过。网关新增协议终端与真正收流结束时刻、受限请求参数与有效推理上下文观测，30 项回归和 15 项独立差分/隐私检查通过，转发与归账语义保持。各测试组有重叠，不累计为独立案例数。证据分别位于 `timing-report-repair-54i/`、`gateway-observation-repair-54i/` 与 `wire-contract-probe/`。

Flipt 配对 `parallel-54j-v2` 于 2026-09-30 10:29 UTC 启动、10:47 UTC 完成。沿用已封存产品 I，配合独立网关 J（42089 / 48767）的新账本；原有成绩、迟到及未知用量保持。Debian 12 / glibc / amd64 环境和网关绑定、官方 Oracle reward=1、双方安装全部通过，准备模型请求为 0。清单 SHA-256 `ede4489b87fb9f45f665a12bb404cec0fdb86667a5702497d4a74e3296cab555`，预检与最终校验分别在 `preflight-54j/acceptance-v2.json`、`validation-54j-v2.json`。前版 J 的旧暴露快照被派发校验拦截，原失败保留；冻结器已在发布清单前执行标准暴露校验，11 项回归通过。新快照追加 I 的七份观察，开发题序和独立保留组隔离保持。

当前持续目标已完成 `parallel-54g`：双方官方 reward=1，请求数均为 18；ScriptAct 解题 1288.218 秒、Codex 385.029 秒。已知参考估算 $1.0159856 对 $0.3690576，分别另有 4 笔、1 笔中断用量未知，完整费用无法比较。本轮 ScriptAct 更慢。控制器、采样已退出，无未结算请求；当前状态入口为 `parallel-54/active-campaign.json`。

54g 候选指纹 `61dcea3608d0f672bc8b1997c0ea6e02398999f49e459d6e3274426ae2f23a6a`。流错误传播与有界恢复的实际验证通过：四次中断帧均零执行，先前成功执行未被重放，首次完成请求直接接受；ScriptAct 有 13 次脚本与 34 次底层调用，完整轨迹分析见 `recovery-audit-54g/`，官方对账见 `settlement-audit-54g/`。离线回归与安装/Oracle 证据在 `validation-54g.json`。

候选 H 已完成共享展示计量与最后活动时序观测，回归、封印及独立源码/构建审核通过。零 API 的真实 Runtime→SDK 测试确认相同预算内补全正文并保留到后帧；在线效率收益仍待验证。固定的 24 道开发压力题覆盖 11 仓库，题序与角色在 `campaign/development-pressure-24-v1.json`，独立 HARD-51 继续隔离。首题新 Proton 的镜像续传暴露了正常进展被计入固定失败上限的问题，通用修复已通过 20 项回归，按单 blob 总期限与连续停滞限制恢复，原始失败和 partial 保留。

按用户要求，先处理 54g 速度差距，修复、独立复核和环境验收现已完成。成功请求生命周期差 538.974 秒，中断请求差 309.188 秒，其余约 54.957 秒在请求区间之外；上下文准备本身仅 1.693 秒。两方全部请求使用相同的 high/default 配置，尚不能把成功请求的首语义等待归因于远端某一层。收尾审计已纠正：原脚本漏读 `runtime.decision.missing`，两份早期 required 正文缺口实际持续到 turn12，释放后 turn13 才清空；这两轮需按框架缺口处理分析。旧审计按原字节保存在 `recovery-audit-54g/*.superseded.*`，官方分数、原始轨迹和账本保持。持续目标推进修复，定时任务已删除。

候选 I 已封存，指纹 `b40f751cf989b23582023c87c8424ab97c277b837bb49aa18e9974569d8c2d44`。它继承 H 的共享正文计量，并修复“当前帧缩容误判历史中完整正文缺失”：只使用本次实际历史内完整交付的引用、块名与内容哈希证明，正文退役或请求超额仍按原边界处理。65 项 Runtime 回归、独立 5 个边界反例与 3 个真实 compose→provider compiler 反例通过。

[Platform 运行主链](../architecture/platform-runtime.md)让完整响应在协议终端到达后结束 SDK 输入，保留原有用量、延续状态和失败语义。171 项 Model 测试、实际归档 SDK 3.0.119 的 16 项终端测试、474 个独立分块边界及构建产物独立检查通过；各组存在重叠，不相加。人工尾流中的终端后等待从 501.67 毫秒降至 1.19 毫秒，不能据此解释原线上差值。正式七包构建、3,954 文件封印、两种 Linux 归档通过，相对 H 的变更限定在 Model/Runtime 的 23 份包文件。依赖锁、模型和推理配置、上下文策略与运行参数保持。

日志与独立审核分别在 `context-efficiency-review-54g/`、`readonly-required-history-audit.json`、`readonly-responses-terminal-audit/`、`latency-repair-54i/`，总索引为 `validation-54i.json`。新 Proton 镜像已实际导入并确认 Alpine 3.18.3 / musl / amd64，准备请求增量为 0，检查容器已清理；官方 Oracle 和双方新候选安装仍是付费派发前置条件。

I 配对清单 SHA-256 为 `ac936048a87e594fc2bf264ceb99973b118f3e37b90d7f48daf0ae4efe738fae`，绑定恢复后的环境证据。冻结器现核对完整镜像/任务/ABI/网关身份与零模型准备记录，所有验证通过后才发布三个冻结文件；也拦截 Codex 本地网关地址缺少 `/v1` 的配置，11 项离线用例通过。双方 musl 安装已完成，官方 Oracle reward=1、模型调用增量为 0、容器清理通过，最终签名账本与资源核对通过：两次安装及 Oracle 均零模型请求，三份租约释放，专用 VM 无容器；启动准入检查通过后进入源任务配对。

历史批次 `parallel-54f`，候选 `bundle-foundation-54f-sol`（指纹 `9240b60fa956e7bbd1494d22a1d9be3bf0d36ff16e6ab8aac4162a385dd0c8f0`）。实际 SDK 请求确认此上游支持该模型及 high，但显式缓存断点须关闭；会话缓存键继续传输。通用能力配置与认证断路、上游身份校验、基础设施失败分类、参考价格归账均已回归，验证索引 `parallel-54/validation-54f.json`。NodeBB 官方 Oracle reward=1、双方安装通过，三次预检零模型调用、清理正常；控制器 **82891** 与采样 **82892** 已结束，实时状态由 `parallel-54/active-campaign.json` 定位。

54f Codex 官方 reward=1，ScriptAct 在第五次请求的流中断后退出，空补丁官方 reward=0。双方各有一次 HTTP200 后 ECONNRESET且缺少用量；ScriptAct 5 次请求、218.350 秒、已知参考估算 $0.2112248；Codex 23 次、505.645 秒、已知参考估算 $0.7326488。完整总费用未知，质量不同不比较成功效率。ScriptAct 四段脚本成功、18 次 shell.run 均成功，中断帧没有执行；Codex 21 次外层 exec、18 次原生命令与 4 次文件修改，命令失败 2 次均由其后续处理。当前持续目标优先修复网关 SSE 错误传播与终态中断分类，使用原始轨迹验证安全恢复，不重派原 source。原始证据及当时 Harbor 源码保存在 `parallel-54/stream-failure-54f/original/`。

本机已建立两个独立评测槽，新批次 ScriptAct 与 Codex 使用 `gpt-5.6-sol / high`，通过同一个签名网关访问模型。专用 Colima VM 为 4 核、10 GiB、48 GiB；每槽按官方题目限制分配 1 核、4 GiB，另留资源给虚拟机及网络服务。网关最多同时处理 4 个请求、每次尝试最多 2 个，美元预算显式 unlimited，保留完整计量和任务时限。

首批 `parallel-54b` 使用已暴露的 Navidrome 仓库题，候选包 `bundle-foundation-54a`，Codex CLI 0.158.0。双方已通过同时安装与清理验收。源任务并行，补丁分别进入全新容器，由官方判分器验证。结果属于开发证据。

执行记录位于 `.velaros-workspace/bench/parallel-54/`：`active-campaign.json` 定位当前控制器，`controller-b/report.md` 展示成绩，`report.json` 保留请求数、各阶段时间、全部费用、费用覆盖率、上下文、缓存、模块及工具分层次数。`resources-b.jsonl` 记录宿主负载和各容器资源。原始结果和轨迹在 `.velaros-workspace/bench/jobs/`。

## 首批真实结果

`parallel-54b` 双方官方 reward=1，源任务、官方重放和清理正常，32 次请求全部结算，累计 $1.5686116。

| 参与方        | 请求 | 解题秒数 | 含重放端到端秒数 |     总费用 |
| ------------- | ---: | -------: | ---------------: | ---------: |
| ScriptAct     |    8 |  263.009 |          380.350 | $1.0207668 |
| Codex 0.158.0 |   24 |  350.163 |          474.729 | $0.5478448 |

ScriptAct 请求少 66.7%、解题快 24.9%，费用高 86.3%。这一个已暴露开发任务不能支持整体优于 Codex 的结论。

ScriptAct 共 19 次底层操作：`shell.run` 15、`project.edit` 1、`system-memory.read` 2、`system-memory.release` 1。Codex 有 23 次外层 exec、13 次原生操作（11 次命令执行、2 次文件修改）；不同层级单列。其原生操作缺少可核对耗时，维持未知。

完整请求重建表明固定 developer 和历史前缀稳定；动态当前帧位于最后。ScriptAct 缓存读占输入 21.32%，Codex 94.62%；前者 77.94% 费用来自缓存写入。GPT-5.6 的历史断点支持依据 [OpenAI 缓存合同](https://developers.openai.com/api/docs/guides/prompt-caching)，线上收益由后续完整费用验证。

真实问题、原始哈希与零模型核对保存在 `context-audit/`、`pricing-reconciliation-54b.json` 和 `output-budget-*.log`。原适配器报告 $0.5103834 仍保留，网关归属账本与修复后定价均为 $1.0207668。

## 本轮修复

- 网关从全局串行改为有界并发，任务签名贯穿费用和迟到结算；无限预算必须显式配置。
- 调度采用跨进程资源租约，取消后等待真实执行、容器和模型费用结算完成才释放槽位。
- 控制器持久化派发意图，未知状态禁止再次发送源任务；已完成源任务可单独恢复尚未派发的官方重放。
- 候选准备验证源码和 dist 指纹并持有构建锁，封印包文件；模型和推理配置在候选、适配器、请求和账本间核对。
- 容器启动健康检查使用本次网关地址和任务凭据。首次安装的 401 原始证据完整保留，修复后双方安装通过，安装阶段没有模型调用。
- 控制器接收 SIGTERM / SIGINT 会转发一次取消并等待 launcher 清理；长 verifier 容器名按 Harbor 实际截断和哈希规则识别。
- 官方 reward 和正常成功分别记录：清理异常即使 reward=1 也进入异常队列，不计入正常成功效率比较。

## 实跑后的修复

- 输出展示：显式 `output.config.maxChars` 在本帧的有限结果份额内生效，默认预算与源码预览继续保守限制；跨长度、Unicode、多个结果租约与小帧预算验证总量和引用语义。
- 费用：候选冻结价格合同与其哈希，适配器据其估算；缺少价格或用量分项保持未知，报告保留原值并与签名网关账本对账。
- 模型能力：根据官方 GPT-5.6 缓存合同补齐已有历史断点的传输。稳定历史布局、当前帧语义与上下文维护规则保持，后续同时核对请求、时间与总费用。

## 持续执行约定

按已冻结开发批次运行、分析完整记录、复现共性问题、并行分工修复、跨场景回归、冻结新候选，再继续下一批。正在运行的候选包和清单不可原地修改。普通解题失败保留并进入诊断；身份、费用或清理错误阻断相关队列。工具使用保留原始模块与操作名，外层调用、脚本执行、底层操作分层统计。

优化依据关注稳定性、解题质量、端到端时间及完整费用；模型生成与推理 token、缓存读写、脚本/工具时长和有效材料交付分层解释成本。补齐后的初始暴露快照记录 26 个任务，后续安装与运行观察持续追加。参考答案不进入产品策略；独立保留组在最终候选冻结前保持隔离。

## 验证

最新 Python 联合回归 134 项通过；模型模块 143 项、输出与上下文链路 78 项、网关及原运行器 Node 联合回归 20 项通过；另有候选完整性和模型身份测试。双容器预检实际确认每槽 1 核 / 4 GiB；格式检查、模块所有权检查、构建证明和双方真实容器安装通过。具体命令和原始日志保存在上述证据目录。

第二批 `parallel-54c` 采用 Proton musl 环境和 `bundle-foundation-54c`。同一依赖锁、模型及运行参数，新增价格合同与三项修复。官方 Oracle 和双方安装均在独立容器通过零模型前置验收；Oracle reward=1。源任务与官方重放已完成，结果在 `controller-c/report.{json,md}`；控制器和资源采样均已退出。

首个 Oracle 预检包装脚本误用了取消参数类型，在官方 trial 创建前失败。修正为 Event 后重新验收通过；旧失败、零请求证明、进程/容器核查与单一租约回收证据保留为 `oracle-54c*.json`。

## Proton 第二批结果与下一轮修复

`parallel-54c` 双方官方 reward=1，全部 21 次请求结算，合计 $0.6699700；对应控制器及采样进程已结束，容量租约清空。

| 参与方    | 请求 | 解题秒数 |     总费用 |
| --------- | ---: | -------: | ---------: |
| ScriptAct |    8 |  242.576 | $0.4095958 |
| Codex     |   13 |  176.301 | $0.2603742 |

ScriptAct 请求少 38.46%，解题慢 37.59%，费用高 57.31%。缓存命中 58.31% 对 91.26%。实际请求中稳定历史断点已经发送且后续读取量增长，证明能力识别修复生效；不同任务间的费用变化不能全部归因于该修复。适配器费用与网关账本精确一致。

ScriptAct 有一次动态 import 导致的脚本失败，另一次过大命令输出触发采集上限；二者均保留，不能以底层工具成功数概括脚本成功。约 329 MB 的累计轨迹写入主要由大输出证据在多轮中重复携带形成，完整模型输入峰值为 22,378 tokens，不能称为模型上下文同等膨胀。修复目标是保留全部原始证据并减少重复序列化和写入。

官方重放中，ScriptAct verifier 260.504 秒、Codex 183.532 秒，测试体分别 0.199 秒、1.229 秒；二者判分输出摘要相同。时间差主要在测试体外，存在约 108.622 秒重叠执行，现有证据不足以归因编译、I/O 或 CPU。细节见 `replay-audit-54c/`。

## GPT-6 Sol 候选与 NodeBB 验收

新候选 `bundle-foundation-54e-gpt6` 指纹 `185ee0ebd281eb91cf1cd0cbfbcf4f32fe41d6ccec342e20363b3f5817cdfe97`，使用 `gpt-6-sol / high` 和 48763 独立签名网关。配对清单 `parallel-54e-manifest.json` SHA-256 为 `ab35ada7354f29a9c2e2ea4dc8b456a8ee2477e42d050fe5a7d5c7f2bc700c37`。

- 动态 `import()` 的字面量依赖进入统一绑定与预检，执行时机由原生模块系统保持；计算目标的拒绝诊断保留模块名。
- 输出模型合同明确原始 JSON 合计 100 万字符，展示预算与原始采集上限分别说明。
- 轨迹实体按会话、调用和内容版本无损存储，兼容旧轨迹；JS/Python 读取、ATIF 与全部统计逐字段一致。54c 离线重放累计写入减少 84.0%，导出均值减少 26.0%，这只是采集环节的测量。
- 报告增加脚本执行状态与失败码，底层工具调用、原生操作和外层模型工具继续分层计数。
- 镜像准备显式绑定本批网关，在下载和载入前核对请求与容器状态。

完整 Script 119 项、相关运行时 33 项、Harbor Python 141 项、采集与网关 Node 12 项、真实 Harbor 集成 15 项通过。生成合同、正式拓扑构建、格式、所有权和相关 lint 检查通过，证据索引为 `validation-54e.json`。

NodeBB 为已经暴露的开发题，25 层镜像摘要及解压内容核对通过，环境为 amd64 / glibc 2.31。双方安装与零模型官方 Oracle 均通过，Oracle reward=1，预检请求为 0，容器清理正常。这批源请求被官方上游以密钥失效拒绝：ScriptAct 1 次、Codex 6 次 HTTP401，均无用量回执，费用保持未知。控制器和资源采样已退出，原始结果位于 `controller-e/`，认证失败的独立重新分类见 `controller-auth-audit-54e-final/`。暴露快照含 207 项观察、26 个任务，独立保留组继续隔离。

## 新接口接入

用户选择的接口为 `https://ai.hedgeho9.cn/v1`，`gpt-5.6-sol / high` 的流式小请求已成功返回。显式断点字段探针为 HTTP400，去掉该字段后 HTTP200；通过模型连接配置表达能力限制，网关保留实际传输行为。

新网关在上游 HTTP401 后阻断后续和排队请求，在途请求仍完整结算；清单声明上游身份后，派发前及获得租约后都核对端点和熔断状态。费用报告按来源分列参考估算，实际供应商扣费保持未知。旧 54e 失败与所有接口探针记录完整保留。
