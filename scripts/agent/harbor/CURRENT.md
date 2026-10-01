# ScriptAct 与 Codex 对照：当前状态

当前新批次使用用户选择的 **`gpt-5.6-sol / high`**，双方通过 **`https://ai.hedgeho9.cn/v1`** 访问模型，每槽 1 核 / 4 GiB、最多两个任务槽，美元预算 unlimited。第三方实际费率未知，官方价只作参考估算。模型、端点和价格依据记录在 `.velaros-workspace/bench/parallel-54/model-selection.json`。

候选 **O 已完成通用修复并封存产品包**：`bundle-foundation-54o-sol`，指纹 `4465fe78affb33da2bc1075090312c5979d51cbe742000a991d566e5d65216e6`。修复包括：预算头变化导致已在历史交付的相同块重发；压力整理已写好同卷叙事后，排队的自动整理重复分配模型；Codex 中断后的旧累计用量被转换器再计一次。Runtime **181/181**、计量与报告 **74/74** 通过，共 255 项；新增用例已包含在这些数量内。Codex 原生记录只读复算的已知参考小计由 $0.4921736 校正为 $0.4689144，完整费用仍未知，原始轨迹、官方成绩及账本保持。3,954 文件封印、3,915 dist 文件核对通过，相对 N 仅 Runtime 14 个产物变化；模型、默认预算、缓存策略和依赖锁保持。本轮新增付费请求 0，累计 127 条请求与 11 条未知用量逐字保留。总验收 `repair-integration-54o/validation.json` SHA `2c371ce83a3866595d52348d20b1456c2ae905aaf5ebeb2a5df2d98c509274e5`。下一步先离线处理批量补读的需求分配，再准备 Linux 归档、暴露清单及新环境安装/Oracle 验收；线上效率收益待验证。

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

修复后的 `parallel-54i` 已完成，双方官方重放 **reward=1**、原生正常完成。ScriptAct / Codex 请求 **6 / 20** 次，解题 **478.733 / 497.859 秒**；从源任务派发到重放清理结算均约 **742.901 秒**。请求少 70%，解题快 3.84%，完整端到端基本相同。已知用量参考估算 **$0.1529856 / $0.3006048**，另有 **2 / 1** 笔中断用量未知，完整成本及实际供应商扣费未知。这是一个新开发题上的观察，不能证明整体领先或归因为某一修复。

正式完整轨迹确认没有重复补读、required 伪缺口或重复执行；两帧中断均零执行。ScriptAct 三次脚本、五次 Kernel 操作（shell.run×4、project.edit×1）全部成功；Codex 18 次外层 exec、12 次原生命令和一次文件操作分层保留。195 秒长脚本主要用于定向测试与包级类型检查，双方都执行了相同两项验证。三次共同断流均为 HTTP200 后 ECONNRESET，末字节之后静默约 60–61.5 秒；跨参与方两次断流只差 6 毫秒，具体故障层仍待定位。

控制器 **80582**、采样 **80583** 均退出，本批 26 条签名请求全部结算，三条未知用量保留；源任务及重放四阶段均清理正常。当前入口 `active-campaign.json`，I 完整对账 `latency-root-cause-54i/`，上下文与工具审计 `context-audit-54i/`。零上游 wire 参数与计时边界核对已完成；当前 Flipt 配对状态见下。不得重复派发运行中或未知状态的源任务。

后续计量修复已通过回归和独立审核：报告保留原 trial 生命周期字段，新增经身份、结果及清理状态核验的完整 attempt 墙钟时间，89 项联合回归通过；54i 原报告保留，独立修订结果在 `timing-report-repair-54i/`。网关补充完整协议终端与实际收流结束时刻、受限 wire 选项及有效推理上下文，30 项回归及 15 项独立差分/隐私检查通过，各组不相加。独立新网关 **42089 / 48767** 已启动、零请求，原 H 账本保持；证据 `gateway-observation-repair-54i/`、`wire-contract-probe/`。Flipt 的 Debian 12 / glibc 环境、新网关绑定、官方 Oracle（reward=1）和双方安装均已通过，准备阶段模型请求为 0。

本批清单 SHA-256 `ede4489b87fb9f45f665a12bb404cec0fdb86667a5702497d4a74e3296cab555`，验证 `validation-54j-v2.json`。前版 J 在派发前因暴露快照陈旧被拦截，零模型请求；冻结器已提前执行同一标准暴露校验，11 项回归通过，原失败清单保留。暴露快照 v2 收录上一批七份观察，固定题序和独立保留组隔离保持。

`parallel-54g` 已结束，双方官方 reward=1，18 次请求对 18 次。ScriptAct 解题 1288.218 秒，Codex 385.029 秒；已知参考估算分别 $1.0159856 与 $0.3690576，另有 4 笔与 1 笔中断用量未知，完整费用无法比较。双方 source/replay 正常完成，控制器 **15352**、采样 **15353** 已退出，没有未结算请求。本轮 ScriptAct 更慢，不能据此声称领先。

54g 使用候选 `bundle-foundation-54g-sol`，指纹 `61dcea3608d0f672bc8b1997c0ea6e02398999f49e459d6e3274426ae2f23a6a`；清单 SHA-256 `c0d4f8285980965845f82d0ed33466bb087cff56885405d62f6006881a7dde56`。真实轨迹验证四次流中断恢复：中断帧均零执行，已成功执行身份各执行一次，首次完成请求直接接受。13 次脚本、34 次底层调用；详细时间、工具失败层与完整记录在 `parallel-54/recovery-audit-54g/`，对账在 `settlement-audit-54g/`，预检及回归索引 `validation-54g.json`。

当前由持续目标推进，定时任务已删除。候选 H 已封存：Script/Runtime 共享最终文字计量，以原 JSON 投影作正文下限并扩展同批 text/code；原数值上限和最终请求编译器保持。155 个合成场景和 17 份历史输出用于设计审计，实际 Runtime→SDK 的零 API 集成已确认同一 2800 字符预算内 2041 字符正文完整送达并在后帧保留。29 项 Script 输出、72 项 Runtime、42 项网关及 4 项轨迹回归通过，独立审核核对七包构建、3,950 文件封印和两种 Linux 归档；这些离线证据尚未证明整题提速。新网关记录最后字节/语义事件时刻，精确模型权限探针已通过。证据 `validation-54h.json`、`readonly-54h-audit.json`、`display-runtime-integration/`。

用户要求优先修复 54g 的速度差距，相关修复已在候选 I 完成并通过验收。成功请求累计差约 539 秒，中断请求差约 309 秒；上下文编译仅 1.69 秒，不能把慢都归因于本地编排或缓存。实际请求、输出生成和流时序已完成首轮核对。原收尾审计遗漏了 `runtime.decision.missing`，只查看了观察区的 `missingRequired`；真实完成区在后期仍列两份早期结果的 `required-body-unavailable`，因此不能将后续释放操作直接归为模型自主浪费。报告已按完整分区纠正，通用完成与材料生命周期机制的修复见下。

候选 I 已封存，指纹 `b40f751cf989b23582023c87c8424ab97c277b837bb49aa18e9974569d8c2d44`。Runtime 修复通过 65 项回归、5 个独立边界反例和 3 个实际请求编译链路反例：正文完整保留在本次历史中时，当前帧缩容不会再次误报同一必需块缺失；折叠、释放或正文退役后仍恢复应有缺口。证明按结果引用、块名和内容哈希绑定，不送进模型提示词。Model 修复完整 Responses 终端之后仍等待传输 EOF 的问题，通过 171 项 Model 测试、实际归档 SDK 3.0.119 的 16 项终端回归及独立审核。七包正式构建身份、3,954 文件封印、glibc/musl 两归档均通过；相对 H 仅 Model/Runtime 包内 23 文件变化，依赖锁与运行参数保持。人工 500 毫秒尾流实验中终端后的等待从 501.67 毫秒降至 1.19 毫秒，不能推算为 54g 整题提速。证据入口 `validation-54i.json`、`readonly-required-history-audit.json`、`readonly-responses-terminal-audit/`，机制说明见 [终端交付修复](../../../docs/engineering/scriptact-responses-terminal-delivery.md)。

开发压力组题序已冻结于 `campaign/development-pressure-24-v1.json`（SHA-256 `1ddb30e8a87cd33d46af0b07e8fafb9651ef7bc07873866c5b1c4121800e9c70`），24 道题按 11 仓库分层并明确登记 development，HARD-51 与旧验证保留题隔离。首题为新的 Proton 仓库任务，官方十份文件和不可变镜像身份已核对。大层连续四个下载窗口正常增长却耗尽旧重试上限，现已修复为有总期限的进展续传、连续停滞限制和损坏文件隔离，20 项回归通过，原始失败及 partial 保留并以新证据目录恢复。I 的速度修复回归、官方 Oracle 与双方安装已通过。

Proton 的实际 26 层镜像恢复导入成功，已核对 Alpine 3.18.3 / musl / amd64；只读检查容器从未启动且已删除，准备阶段新增模型请求为 0、租约和容器均清空。证据 `development-pressure-24/01-proton/environment-ready.json`。环境就绪尚不替代新候选的官方 Oracle 与双方安装验收。

I 配对清单已冻结为 `parallel-54i-manifest.json`，SHA-256 `ac936048a87e594fc2bf264ceb99973b118f3e37b90d7f48daf0ae4efe738fae`，绑定恢复后的镜像证据与双方 musl 包。冻结器增加环境身份及网关 `/v1` 路径检查，11 项离线反例通过。I 的双方安装均通过，官方 Oracle reward=1、模型请求 0、容器清理通过；最终签名账本对账确认双方安装请求为 0、Oracle 请求为 0、全部三份租约释放，专用 VM 容器清空；进入启动准入后可派发一批修复后的配对。

54f 原始失败与未知费用保留：ScriptAct 第五次模型请求中断后退出、空补丁 reward=0，Codex reward=1。原报告、账本、清单和当时 Harbor 源码位于 `parallel-54/stream-failure-54f/original/`。

`parallel-54c` Proton 配对已完成，双方官方 reward=1、费用全部结算。ScriptAct 8 次请求、242.576 秒、$0.4095958；Codex 13 次请求、176.301 秒、$0.2603742。ScriptAct 请求少 38.46%，解题慢 37.59%，费用高 57.31%。缓存断点修复在线生效，但整题效率仍有差距。

新候选 `bundle-foundation-54e-gpt6` 已封存，指纹 `185ee0ebd281eb91cf1cd0cbfbcf4f32fe41d6ccec342e20363b3f5817cdfe97`。动态 import 绑定/预检/诊断、原始输出上限模型合同、无损轨迹去重、脚本失败分层统计及新网关镜像准备已修复。119 项 Script、33 项运行时、141 项 Python、12 项采集/网关 Node 和 15 项真实 Harbor 集成回归通过。证据见 `parallel-54/validation-54e.json`。

`parallel-54e` NodeBB 的双方安装和零模型 Oracle 均通过，但官方上游密钥失效导致 7 次 HTTP401（ScriptAct 1、Codex 6），未开始解题。控制器、采样及对应网关已退出；原始 source/replay、判分、账本与 7 笔未知用量完整保留。认证分类在独立副本 `controller-auth-audit-54e-final/` 核对，不将这批作为模型解题能力成绩。

新上游网关 48764 已通过实际 SDK 请求验证。通用连接配置 `openaiExplicitCacheBreakpoints=false` 适配其能力，会话缓存键保持。新候选 `bundle-foundation-54f-sol` 指纹 `9240b60fa956e7bbd1494d22a1d9be3bf0d36ff16e6ab8aac4162a385dd0c8f0`，NodeBB 配对清单 `parallel-54f-manifest.json` SHA-256 为 `bdfb012f8ecfbf7488a2b26e69fd98479dc0c2bf4041041ae7a3d789acc1f5e2`。认证断路、端点身份、失败分类与参考价格归账已修复；146 项模型、163 项 Python、19 项真实 Harbor/准备集成及 8 项采集/准备 Node 检查通过，各组有重叠，不相加。证据见 `parallel-54/validation-54f.json`。

54f 双方安装与官方 Oracle 均正常完成，Oracle reward=1，三次预检模型调用均为 0、容器清理正常。配对控制器 **82891**、资源采样 **82892** 已结束；以 `parallel-54/active-campaign.json` 为实时状态入口。所有探针单独归属 `provider-preflight-54f`，实际供应商扣费保持未知。

第 54 轮并行环境已建立，首批 `parallel-54b` 双方官方 reward=1。相同 `gpt-5.6-sol / high`、每槽 1 核 / 4 GiB：ScriptAct 8 次请求、263.009 秒、$1.0207668；Codex 24 次请求、350.163 秒、$0.5478448。ScriptAct 请求少 66.7%、解题快 24.9%，费用高 86.3%；这是已暴露开发题的单次配对结果。所有 32 次请求均已结算，两槽及容器已释放。

首批暴露的三项问题已修复：显式输出预算现在可使用有限帧份额；适配器按候选冻结价格计费；GPT-5.6 已有历史断点正常传输。134 项基础设施、143 项模型、78 项输出与上下文回归通过。新候选 `bundle-foundation-54c` 指纹 `5a63761be61f4d9f7b90b6b05e26b5378009002a10046170cb37d09753f0c19a`；Proton musl 上双方安装及官方 Oracle（reward=1、零模型调用）已通过；`parallel-54c` 的 source/replay 已完成，控制器及资源采样已退出，两个槽位均释放。实时入口 `.velaros-workspace/bench/parallel-54/active-campaign.json`，详细环境及结果见 [并行评测记录](../../../docs/engineering/scriptact-parallel-evaluation.md)。

第 53 轮已完成根基修复与联合验收：2,783 项通过、10 项条件跳过，8 个包完成构建，类型、格式、模块所有权、生成合同与独立打包消费者检查通过。具体修复、证据及边界见 [根基修复报告](../../../docs/engineering/scriptact-foundation-fixes.md)。第 52 轮的审核作为问题来源保留，见 [完整审核报告](../../../docs/engineering/scriptact-foundation-audit.md)。

第 51 轮已修复过拟合审计的四项问题：补读区分条目与字符并按所需缺口定位，领域指引按能力注入，任务暴露归属在派发与报告时自动校验，工具发现覆盖嵌套工程并明确扫描边界。180 项相关本地回归通过；518 份历史 campaign JSON 哈希保持，新增 API 请求与费用均为 0。详见 [修复结果与证据](OVERFITTING-FIXES.md)，诊断过程见 [第 50 轮审计](OVERFITTING-AUDIT.md)。

第 49 轮继续处理第 48 轮台账：修复 libc 运行时选择、轨迹全量导出、补读定位与编辑诊断，补上实际工具环境，调整协议及验证指引，并完善多目标费用比较。308 项相关本地回归通过，Alpine 运行时自检通过。旧轨迹离线回放中，采集写入量减少约 80% / 54%，最终记录一致。详见 [修复结果与证据边界](LOCAL-FIXES.md)；完整历史分类见 [第 48 轮回顾](RETROSPECTIVE.md)。

第 51 轮结束时历史账本累计 1620 次请求、已知估算 $44.1233191、保守占用 $122.8703382；两笔历史未知用量继续保留。第 54 轮使用独立账本，显式取消总美元限额，保留供应商限流、任务时限和资源限制。

第 47 轮 **field-read-v1** 修复与同题验证完成。`memory.read({ ref, pointer, offset, limit })` 可直接分页读取已授权执行归档中的字段，字符串按原文返回，其他值按 JSON 返回；省略路径时沿用整份归档读取。校验路径、范围、自有属性、任务权限与取消，旧宿主忽略路径会明确报错。模型合同、模板、字段召回示例及文档同步更新。

136 项相关回归完成，真实脚本补齐缺失代码后下一轮模型可见，既有历史稳定、源操作没有重跑。原 Navidrome 轨迹的三个尾段均一次精确补读 4000 字符，其中完整重建 93288 字符归档原需两页。该离线数据仅反映归档补读，不推导模型请求或整题费用收益。构建、格式、所有权、ESLint、自动生成合同、能力目录与 diff 检查通过。

安装控制器 **60945**、源任务和官方全新容器重放控制器 **98616** 均退出 0。全部五次原始尝试官方 reward=1，源任务与重放无异常，用量均已结算，同一初始工作树：

| 候选                                    | 请求数 |   解题秒数 |   整次费用 | 含官方重放秒数 |
| --------------------------------------- | -----: | ---------: | ---------: | -------------: |
| Codex 0.158.0 / 43                      |     14 | 194.583037 | $0.2145132 |     286.311918 |
| ScriptAct output-redistribution-v1 / 43 |     11 | 231.076925 | $0.2959998 |     322.937546 |
| ScriptAct code-read-v1 / 45             |      9 | 173.061290 | $0.2428769 |     265.628376 |
| ScriptAct code-read-v2 / 46             |     11 | 213.408447 | $0.3688909 |     306.868156 |
| ScriptAct field-read-v1 / 47            |      9 | 195.277362 | $0.2962006 |     287.210244 |

本轮相对上一轮请求少 18.18%、解题时间少 8.50%、费用少 19.71%；相对 Codex 请求少 35.71%，时间高 0.36%，费用高 38.08%。相对第 45 轮请求相同、时间高 12.84%、费用高 21.96%。单题结果保留全部对照，不声明整体领先。

相关 metadata 三包测试 60.146 秒通过，gofmt 与 diff whitespace 通过；官方重放 51.549 秒。15 次宿主操作，1 次 TARGET_NOT_FOUND 精确编辑拒绝和 1 次 Shell 非零退出均计入，0 次脚本失败、0 次协议拒绝；本次未出现完全相同源码的重复执行组。实际输出 3 个 code 块，字段补读调用 **0**，因此整题改善不能归因于新补读功能。输入 237217 token、输出 9626 token，峰值 44408、缓存命中率 72.05%；模型 118.70 秒、脚本 68.69 秒，轨迹导出 0.997 秒 / 67.97 MB。

候选指纹 `4b5d3e8b1a5058dba4e9750b853ccef3d40678c57ef223451dd71953182289fe`；清单 SHA-256 `a0159c089690d17a6e677f64783d6a44fff5453e975dc19c60e64664da5b251f`。依赖锁、运行参数、展示/上下文/缓存上限及 20 个执行文件保持一致。证据：`campaign/field-read-47-local-validation.json`、`campaign/field-read-47-offline-replay.json`、`sol-scriptact-codex-validation-47-report.{json,md}`、`campaign/validation-47-read-behavior.json`、`campaign/validation-47-scriptact-final-diagnosis.json`、`campaign/validation-47-final-checks.json`。产品合同差量说明在 `probes/field-read-47/README.md`。

本轮仅新增 9 次模型请求、约 $0.2962006；累计 1620 次、已知估算 $44.1233191，保守占用 $122.8703382 / $1000，两笔历史未知用量继续预占。网关及 VM 空闲。后续先核查重叠读取与字段补读的选择成本、精确编辑失败的上下文依据，再决定局部修复和真实验证。原验证组的 Proton Alpine 环境仍待修复；独立题数保持。

第 46 轮按用户要求进行的 **code-read-v2** 同题验证完成，安装控制器 **25615**、源任务与官方重放控制器 **31575** 均退出 0。以下四次原始尝试全部官方 reward=1、原生 completed、源任务及重放无异常，同一初始工作树，全部模型用量已结算。只新增一次 ScriptAct 尝试，独立题数不变。

| 候选                                    | 请求数 |   解题秒数 |   整次费用 | 含官方重放秒数 |
| --------------------------------------- | -----: | ---------: | ---------: | -------------: |
| Codex 0.158.0 / 43                      |     14 | 194.583037 | $0.2145132 |     286.311918 |
| ScriptAct output-redistribution-v1 / 43 |     11 | 231.076925 | $0.2959998 |     322.937546 |
| ScriptAct code-read-v1 / 45             |      9 | 173.061290 | $0.2428769 |     265.628376 |
| ScriptAct code-read-v2 / 46             |     11 | 213.408447 | $0.3688909 |     306.868156 |

v2 相对 v1 请求增加 22.22%、解题时间增加 23.31%、费用增加 51.88%；相对 Codex 请求少 21.43%，时间高 9.67%、费用高 71.97%。相关 metadata 三包测试 59.849 秒通过，格式及 diff whitespace 检查通过，官方重放 52.355276 秒。28 次底层操作、1 次精确编辑原文不匹配拒绝（写入前返回候选）、2 次 Shell 非零退出（工具/路径问题随后处理）、0 次脚本失败、0 次协议拒绝。模型累计 130.51 秒、脚本 73.31 秒、轨迹导出 1.351 秒 / 98.75 MB；所有失败和重试都计入完整成绩。

输出类型调整本次被部分采用：实际归档有 4 个 code 正文块，未再发生上轮对象误标 text 的脚本错误；memory.read 补读调用为 0，仍有重叠来源读取。记录的首个模型回复已经包含 4 个 execute 控制段，其中 3 段源码完全相同，另一段只输出 placeholder，额外三段执行耗时约 2.754 秒。证据属于同一模型回复内的重复程序，不能据此自动去重可能有副作用的任意脚本。

本次总输入 341,089 token、输出 10,438 token，相对 v1 增加 75.04% 和 60.81%；输入峰值 48,574，缓存命中率从 68.98% 升至 74.98%，完整费用仍上升。v2 的整题效率尚无改进证据，单次观察也不能将全部差值归因于指引修改。后续先对重复控制段和超量/重叠读取做零模型诊断，再决定产品修复与付费验证；原验证组的 Proton Alpine 环境修复仍待处理。

本轮只验证已封存包，产品代码保持；候选指纹 `b4f07706a2c518d343a8822bcd90f549089fcd00f563a6e217c9365d80515867`。清单 `campaign/scriptact-codex-validation-46.json` SHA-256 `9cf704aa76434ac70fc522432e257cf04a6850d36af4528549aa6795e30ea0fc`，全部 20 个执行文件与包身份终验相同。报告 `sol-scriptact-codex-validation-46-report.{json,md}`、诊断 `campaign/validation-46-scriptact-final-diagnosis.json`、读取行为 `campaign/validation-46-read-behavior.json`、终验 `campaign/validation-46-final-checks.json` 保留全部四次尝试。

本轮新增 11 次请求、$0.3688909；累计 1,611 次，已知估算 $43.8271185，保守预算占用 $122.326067 / $1,000，两笔历史未知用量继续预占。网关与专用 VM 当前空闲。

第 45 轮 Navidrome 同题指引优化验证已完成，控制器 **48550** 退出 0。Codex43、原 ScriptAct43、新候选45 均官方 reward=1、原生完成，源任务及重放无异常，同一初始工作树，全部用量已结算。

| 候选                                    | 请求数 |   解题秒数 |   整次费用 | 含官方重放秒数 |
| --------------------------------------- | -----: | ---------: | ---------: | -------------: |
| Codex 0.158.0 / 43                      |     14 | 194.583037 | $0.2145132 |     286.311918 |
| ScriptAct output-redistribution-v1 / 43 |     11 | 231.076925 | $0.2959998 |     322.937546 |
| ScriptAct code-read-v1 / 45             |      9 | 173.061290 | $0.2428769 |     265.628376 |

新候选相对原 ScriptAct 请求少 18.18%、时间少 25.11%、费用少 17.95%；相对 Codex 请求少 35.71%、时间少 11.06%、费用仍高 13.22%。相关 metadata 全部三包测试 65.953 秒通过，gofmt、diff 检查及实现补丁审阅通过。18 次底层操作、1 次 Shell 非零退出、1 次脚本输出类型失败、0 协议拒绝；失败与补读全部计入。模型累计 88.80 秒、脚本累计 75.64 秒；轨迹导出 0.742 秒 / 45.88 MB。请求输入峰值 37,972 token、缓存率 68.98%。

读取行为仍有问题：首批代码/测试/调用方输出共 46,670 字符；模型继续整批 JSON 输出并重复读取，没有使用 code 正文拆分和 memory.read 补读。一次把整个回执对象标为 text，触发类型错误后重读。因此这次整题改善只作观察结果，不能归因于未采用的输出方式，也不能判定总体领先。报告 `sol-scriptact-codex-validation-45-report.{json,md}`、诊断 `campaign/validation-45-scriptact-final-diagnosis.json` 和终验 `campaign/validation-45-final-checks.json` 保留原始三次成绩。

当前产品指引已补充明确的字符串类型约束与可执行回执拆分示例，封存为 **code-read-v2**，指纹 `b4f07706a2c518d343a8822bcd90f549089fcd00f563a6e217c9365d80515867`。65 项相关回归再次通过，直接提取实际指引示例的零模型探针验证状态/失败诊断保留、代码片段交付、原文归档、memory.read 分页补齐及旧历史稳定；构建、格式、所有权、ESLint 与打包通过。v2 的本地验证证据为 `campaign/code-read-v2-local-validation.json`，后续整题验证见上方第 46 轮。相对本轮修改前指引源码净增加 398 字符；正式声明、依赖锁、12,000 字符展示上限、上下文/缓存/历史政策、20 个执行文件保持。v1 的冻结包与本次结果保留。

本轮仅新增 9 次付费请求、约 $0.2428769；累计 1,600 次，已知估算 $43.4582276，保守预算占用 $121.6404752 / $1,000，两笔历史未知用量继续预占。网关及专用 VM 当前空闲。后续先完成下述 Proton 共享 Alpine 环境修复，进行零模型验证后继续原验证组，再进入 HARD-51。

本轮清单 `campaign/scriptact-codex-validation-45.json` SHA-256 `1f6c5c81e6d0c33dea8f012ae81e09224629da93864a760aaa0232f1a06be10c`；复用原 Codex43 基线，独立题数保持。离线结构假设仍见 `campaign/validation-43-code-output-offline.json`：同一展示上限，两份代码输出可见正文增加 13.72% 和 9.52%，该回放不等于整题模型收益证明。

工具计数的分析口径已修正，新增 `tool_call_scope` 和 Codex `native_operations`：Navidrome43 的 Codex 为 13 次外层调用、19 次命令执行、2 次文件修改操作；ScriptAct 为 10 次脚本执行、22 次底层能力操作，其中 16 次 Shell 回执。各层分别报告。41 项回归、格式和模块所有权检查通过，修正前 4 项检查失败；真实原轨迹重算确认全部原始成绩、请求、时间、费用与对比结果逐字段一致。原报告保留，补充报告 `sol-scriptact-codex-validation-43-measurement-revision-1.{json,md}`，验证 `campaign/validation-44-tool-counts-local-validation.json`。20 个执行文件及双方冻结包相同，准备新增 0 次调用。

第 44 轮 Proton 的准备控制器 **68096** 已退出 1，停在官方 Oracle 的环境启动阶段；双方付费任务均未派发，模型计数保持 1,591。22 个压缩层及解压摘要、精确镜像身份已验证并导入；下载耗时 1,110.48 秒。镜像为 Alpine 3.18.3，断网探针复现两个准备兼容问题：BusyBox `setsid` 不支持 `--wait`，GNU uv 需要不存在的 glibc loader。现有打包 Node 同属 GNU 运行时，也须验证 Alpine 启动支持。证据 `campaign/validation-44-setup-reproduction.json`，原始 Oracle 结果保持；先修复共享兼容层、验证取消与双方安装，再封存新的执行协议与 Oracle 尝试。当前网关和专用 VM 空闲，新增模型请求 0。

准备记录 SHA-256 `046568a70b148470f3f6272b556ec9f3983ec1a4188e1cac142b576c745747c2`，原始任务和双方候选在 Oracle 前固定；现有历史尝试使用原冻结执行文件，后续协议改动须另行记录。

HARD-51 的 51 题、11 仓库顺序已仅根据官方 ID 与元数据固定，`campaign/hard51-order-v1.json` SHA-256 `d49e508439f011518e2e5923daa24847a614bf6fe7dead614ae4ae99809840ed`，新增 0 次模型请求。采用固定种子的仓库轮转，原组完成后按序进入；各题的参与方仍须事先封存，候选演进分别报告。

第 43 轮 Navidrome 首次独立对照完成，Codex 控制器 **50171**、ScriptAct 控制器 **74864** 均退出 0；双方官方 reward=1、原生完成，源任务及重放无异常，同一初始工作树，全部用量已结算。

| 候选                               | 请求数 |   解题秒数 |   整次费用 | 含官方重放秒数 |
| ---------------------------------- | -----: | ---------: | ---------: | -------------: |
| Codex 0.158.0                      |     14 | 194.583037 | $0.2145132 |     286.311918 |
| ScriptAct output-redistribution-v1 |     11 | 231.076925 | $0.2959998 |     322.937546 |

本题 ScriptAct 请求少 21.43%，解题慢 18.75%，费用高 37.99%。相关 metadata 测试 58.475 秒通过，后续修改后 FFmpeg 测试 1.847 秒通过，格式、diff 检查及补丁审阅完成。22 次工具调用、0 工具异常、0 协议拒绝；gofmt 因登录 PATH 缺失失败一次，随后恢复。双方均遇到 Go 工具路径问题。模型累计 152.06 秒、脚本 70.67 秒；轨迹导出 0.917 秒 / 63.89 MB；输入峰值 34,205 token、缓存率 67.60%。

一次批量读取返回 44,836 字符，展示上限 12,000，随后重复读取并释放 3 份旧结果。原文保持；离线 16,000 字符回放仍未让主要输出完整。当前证据支持检查读取粒度和展示效率，不能直接证明增大上限会改善整题时间与费用。诊断 `campaign/validation-43-scriptact-final-diagnosis.json`，回放 `campaign/validation-43-output-budget-offline.json`，报告 `sol-scriptact-codex-validation-43-report.{json,md}`。

累计 1,591 次调用，已知估算 $43.2153507，保守预算占用 $121.1871764 / $1,000，两笔历史未知用量仍预占。该轮完成时网关 **88860** 与专用 VM 空闲。接下来按原序准备位置 8 Proton WebClients，候选保持 output-redistribution-v1。

第 43 轮准备控制器 **34210** 退出 0，27 个压缩层及解压摘要、精确镜像身份、Oracle reward=1、双方安装均通过，准备新增 0 次调用。清单 SHA-256 `4d43761ec6ba7b9450aee2249cf95e8bd640fe3f6f7c8c9d0acdb3a8144c6133`，准备记录 SHA-256 `69de6a811e7a3a8d7e67145c1c7d9349cbcb391cb06eade7910cafa38e03fbdd`；双方 GPT‑6 Sol high，20 个执行文件相同，10 个任务文件核对原始字节。已回收专用 VM 闲置 Vuls 镜像缓存，原始产物保留。

已有原验证组首次结果索引见 `COHORT.md`，审计 `campaign/validation-43-cohort-first-attempt-audit.json`。不同候选与历史传输配置分别标注；Teleport 原源环境差异单列，原始失败与修正重放证据保持。

第 42 轮 OpenLibrary 首次独立对照完成，Codex 控制器 **52774**、ScriptAct 控制器 **20422** 均退出 0；双方官方 reward=1、原生正常，源任务和全新容器重放无异常，同一初始工作树与镜像，全部用量结算。

| 候选                               | 请求数 |   解题秒数 |   整次费用 | 含官方重放秒数 |
| ---------------------------------- | -----: | ---------: | ---------: | -------------: |
| Codex 0.158.0                      |     29 | 351.996057 | $0.4513117 |     400.379971 |
| ScriptAct output-redistribution-v1 |     11 | 237.729020 | $0.3648197 |     287.317564 |

本题 ScriptAct 请求少 62.07%、解题快 32.46%、费用低 19.16%。相关导入测试最终 102 项通过，随后聚焦文件 28 项通过，Ruff、diff 检查与补丁审阅完成。29 次工具调用，无工具异常或协议拒绝；4 次 Shell 非零退出来自任务内测试与 lint，模型已修正。模型累计 208.68 秒、脚本累计 19.88 秒，轨迹导出 1.03 秒 / 80.99 MB；输入峰值 48,301 token、缓存率 75.88%。Codex 最终相关模块 144 项通过、1 项预期失败。不同合理验证范围全部保留，各自官方判分均通过。

报告 `sol-scriptact-codex-validation-42-report.{json,md}`，诊断 `campaign/validation-42-scriptact-final-diagnosis.json`。保留第 41 轮 Vuls 退步结果；单题优势不能推断总体领先。第 42 轮完成时累计 1,566 次调用、已知估算 $42.7048377、保守占用 $120.2357304 / $1,000，两笔历史未知费用仍预占；该轮结束时网关与专用 VM 空闲；当前进展以上方第 43 轮为准。

第 42 轮准备控制器 **48271** 退出 0，24 个压缩层和解压摘要、精确镜像、Oracle 1 分与双方安装均通过，准备新增 0 次调用，下载 318.35 秒。清单 SHA-256 `f1326d8fa0f5933cb20164b1b70666221d71843b916c0a96cc45c3b04ba0b115`；准备记录 `campaign/validation-42-openlibrary-preparation.json` SHA-256 `275d3853b31844ef67884981a8e20579638a43c5c0b0f8bcbb106d31503d1966`。已回收专用 VM 的闲置 NodeBB 镜像缓存，原始镜像、结果、补丁均保持，证据 `campaign/validation-42-vm-cache-reclamation.json`。

第 41 轮 Vuls 修复验证已完成，控制器 **60316** 退出 0，官方 reward=1、原生 completed，源任务及重放均无异常。全部用量已结算，原第 40 轮双方成绩完整保留：

| 候选                                 | 请求数 |   解题秒数 |   整次费用 | 含官方重放秒数 |
| ------------------------------------ | -----: | ---------: | ---------: | -------------: |
| Codex 0.158.0 / 40                   |     31 | 490.329249 |  $0.585607 |     767.842741 |
| ScriptAct verification-scope / 40    |     17 | 524.739804 | $0.5199364 |     802.235255 |
| ScriptAct output-redistribution / 41 |     20 | 549.980957 | $0.6133093 |     825.167114 |

三次官方验证全部通过。新候选相对原 ScriptAct 请求增加 17.65%、时间增加 4.81%、费用增加 17.96%；相对 Codex 请求少 35.48%、时间多 12.17%、费用多 4.73%。这次展示修复有离线正确性证据，没有整题效率收益证据，不以单次已观察任务推断代码变更造成全部差异。

两个编辑拒绝均在写入前完整返回候选位置；新增测试用了不存在的类型字段，修正后相关三包测试通过，后续代码/测试修改也完成必要重跑。四次测试命令分别为 233.245 秒成功、4.121 秒编译失败、3.622 秒成功、5.188 秒成功。格式、diff 检查和补丁审阅完成。27 次工具调用、0 协议拒绝，模型累计 275.98 秒、脚本累计 264.72 秒，轨迹导出 3.46 秒 / 292.15 MB；峰值输入 63,861，缓存率 82.27%，缓存率上升而完整费用仍上升。

候选修复批量输出的闲置展示空间返还，整体预算和显式策略保持，110 项回归通过，新增 3 项修复前均失败。原输出离线对照确认两段改善：代码从 62 行到 75 行，另一个编辑回执从片段变为完整；已有完整块、原值、引用和冻结历史保持。投影 16 段的平均耗时从 13.32 毫秒增至 50.90 毫秒，计入诊断。构建、格式、模块所有权、ESLint、安装检查均通过，准备新增模型请求 0。

清单 `campaign/scriptact-codex-validation-41.json` SHA-256 `626de8a6e4bdb1df5901af95cb1761982a06b915cc56ade1d0f6d9c244a5145d`；候选 `bundle-sol-output-redistribution-v1`，指纹 `9cb584141f1ba8d6f8a30e2223b13fc5fcb28189858b6e8f24adc14db467547d`，Linux 归档 SHA-256 `8e86e5799eda9077d61ac0e035ab4676232b51a1e59299b52488f3c7a81f73f6`。正式声明、依赖锁、Runtime 设置、20 个执行文件逐字一致。产品验证 `campaign/output-redistribution-41-local-validation.json`；报告 `sol-scriptact-codex-validation-41-report.{json,md}`，终态诊断 `campaign/validation-41-scriptact-final-diagnosis.json`。

第 41 轮结束时累计 1,526 次模型请求，已知估算 $41.8887063，保守预算占用 $118.7274626 / $1,000，两笔历史未知用量继续预占。该轮结束时网关 **88860** 与专用 VM 空闲；当前进展以上方第 42 轮为准。

第 40 轮清单 SHA-256 `accafd5d595a83b243a74b1aba86dc1a4c8527c65125c47d1ed98610252f25d5`。双方在 Oracle 前固定为 Codex 0.158.0 和第 39 轮 verification-scope-v1，20 个执行文件与上一轮逐字相同。准备记录 `campaign/validation-40-vuls-preparation.json`，SHA-256 `2e4817c04fb25c543c423fa46f5f3e2d9310df686b5e8028e1495eb424ff3a56`；10 个官方文件核对 Git 原始字节。已回收专用 VM 中已完成 Teleport 的闲置镜像，可用空间恢复到约 10 GiB，证据 `campaign/validation-40-vm-cache-reclamation.json`。

登录环境兼容性核对 `campaign/validation-40-login-compatibility-review.json` 确认核心平台和共享环境均明确采用登录语义；后续环境优化须处理配置优先级。当前沿用已封存 Shell 行为，通过新题检验当前候选。

第 39 轮验证范围优化已完成：ScriptAct 源任务和官方新容器重放均正常，reward=1，控制器 **93454** 退出 0。保留第 38 轮 Flipt 新题双方原始基线，控制器 Codex **92279**、ScriptAct **39650** 均退出 0；同一初始树、镜像、资源、执行环境，三次尝试全部用量已结算。

| 候选                                    | 请求数 |   解题秒数 | 整次模型费用 | 官方验证秒数 | 含重放秒数 |
| --------------------------------------- | -----: | ---------: | -----------: | -----------: | ---------: |
| Codex 0.158.0 / 第 38 轮                |     20 | 415.794772 |   $0.3138522 |    85.778561 | 541.610532 |
| ScriptAct redis-daemon / 第 38 轮       |      9 | 540.835293 |   $0.2793824 |    87.098601 | 669.154429 |
| ScriptAct verification-scope / 第 39 轮 |      7 | 373.450808 |   $0.2210531 |    85.483525 | 499.599353 |

第 39 轮相对原 Codex：请求少 65%、解题快 10.18%、费用低 29.57%，三个主指标均改善；含官方重放总时间也更低。相关测试、调用方编译、格式、diff 检查、补丁审阅及官方独立判分通过。这是已观察任务的一次优化验证，不能推断总体领先，也不能把全部差值归因于提示调整。第 38 轮原 ScriptAct 请求少 55%、费用低 10.98%，解题慢 30.07%，原结果保持。模型阶段累计 168.03 秒对 224.23 秒；ScriptAct 脚本累计 364.40 秒。相关 Go 测试已通过（235.531 秒）后又跑全仓库测试（73.606 秒），Redis testcontainers 因沙箱内没有 Docker daemon 失败；随后排除该包重跑 5.232 秒，相关包 vet 加 diff 检查 41.422 秒。所有时间、失败及环境限制均保留。两边均遇到 Go 不在 PATH 并自行找到安装路径。没有新的协议拒绝、工具调用异常或结果遗漏。

第 39 轮通用指令根据改动、受影响调用方和项目要求确定必要检查，扩大或重复验证需有具体依据，环境失败保持可见。构建、格式、所有权、ESLint 和 41 项现有回归通过；包差异仅工作指令、其 source map 和身份，依赖锁、Runtime 配置、上下文与缓存政策相同。安装预检 **56486** 退出 0，准备新增 0 次模型调用；真实源任务 7 次请求、全部完成，官方重放 reward=1。

实际轨迹：14 次工具调用，0 工具异常、0 协议拒绝。修改、格式和相关 Go 测试合并在同段执行，相关测试 230.409 秒通过；随后检查 diff 与补丁。模型累计 129.32 秒、脚本累计 236.85 秒、上下文准备与轨迹导出单列于报告。峰值输入 33,831 token，缓存命中率 65.02%，Codex 为 93.15%；缓存率更低但完整费用更低，主指标保持整次任务口径。

第 39 轮清单 SHA-256 `5b6950bb4da53981576192b93d51735d44f61d99ec0fe1b4665aea8ec1b19117`；候选 `bundle-sol-verification-scope-v1`，指纹 `22a97d61b78f6a3989ec5aa9fc906ec175302c603845cd13a80c193b7d21af46`，Linux 归档 SHA-256 `90e960dc9869088c31d0bb7d047ac8f85dfe3f83b5656eb882c33d811a8f85c6`。报告 `sol-scriptact-codex-validation-39-report.{json,md}` 保留原始双方及新候选，诊断 `campaign/validation-39-scriptact-final-diagnosis.json`。

第 38 轮报告 `sol-scriptact-codex-validation-38-report.{json,md}`，诊断 `campaign/validation-38-scriptact-final-diagnosis.json`。第 39 轮后累计 1,458 次模型请求，已知估算 $40.1698536，保守预算占用 $115.4894822 / $1,000；两笔历史未知用量保持预占。网关 **88860**，该轮完成时专用 VM 与网关空闲；当前进展以上方第 42 轮状态为准。

第 38 轮清单 SHA-256 `04a64ba6ec94a22b527e031bbc9920bc530ea49332cc469f4e66ce3cc96c530c`。原组位置 3，首次付费对照；镜像 21 层及解压摘要、官方 Oracle 1 分、双方安装均验证通过，准备新增 0 次模型调用。原候选 `bundle-sol-redis-daemon-v1` 指纹 `3d0a9f45c0cd95f38ac525453233fa88847cdf78b3e27de8ca6a89c0842b6f62`。

第 37 轮 NodeBB 修复验证已完成：查询 `command -v/-V` 返回真实路径，`redis-server --daemonize yes` 后的测试链在同次调用返回退出码及完整结果。107 项回归通过、6 项平台条件跳过，实际镜像零模型探针和真实任务验证通过。各次 reward 均为 1，原始 Codex 基线只运行一次：

| 候选                                | 请求数 |   解题秒数 | 整次模型费用 | 含重放秒数 |
| ----------------------------------- | -----: | ---------: | -----------: | ---------: |
| Codex / 第 35 轮                    |     17 | 153.489634 |   $0.2966446 | 231.185138 |
| ScriptAct raw-output / 第 35 轮     |     10 | 182.810119 |   $0.2798079 | 262.309702 |
| ScriptAct command-lookup / 第 36 轮 |     10 | 144.144080 |   $0.2447798 | 221.896470 |
| ScriptAct redis-daemon / 第 37 轮   |     10 | 134.107366 |   $0.2709675 | 213.495601 |

第 37 轮较 Codex 请求少 41.18%、解题快 12.63%、费用低 8.66%；相对第 36 轮更快但费用增加。保留所有版本，这是已观察题目的修复验证，不能推断总体领先。

## 优化与比较规则

当前统一 `gpt-5.6-sol / high`，对照 Codex 0.158.0，模型与上游以当前冻结清单为准。相同任务正确完成和必要验证是前提；优化完整模型请求数、解题墙钟时间和整次任务费用，同时记录官方验证及端到端耗时。一次请求塞入更多信息如果让总耗时或费用变差，不算整体改进。缓存命中率、token、上下文和工具调用用于解释原因；每次改动需验证实际收益。

先修复已定位的问题，再付费验证。全部拒绝、重试、整理、失败及未知费用保留。每个封存参与方一次，不按结果选择最好尝试。同题产品修复沿用事先指定的原始 Codex 参考。执行协议有经独立复现的缺陷时，修复后另建明确的协议与任务记录，保留原失败及费用，不能冒充新题或覆盖原成绩。

当前美元预算 unlimited，最多两个任务槽，资源租约和网关请求并发限制继续生效。实际供应商扣费未知时只报告参考估算；历史未知用量和迟到结算保持原记录。运行状态以当前控制器、资源租约和网关 health 为准。第 39 轮累计 1,458 次请求、已知估算 $40.1698536 和保守预算占用 $115.4894822 是当时的历史快照。

专用 Colima `scriptact-bench`：2 CPU / 6 GiB / 24 GiB，ARM64 宿主经 Rosetta 运行 Linux AMD64。双方任务 1 CPU / 4 GiB，源阶段 3,000 秒，Agent 2,940 秒，随后全新容器官方重放。

## 已修复与验证

官方 NodeBB 镜像自带三个未跟踪的 Redis 数据文件，第 34 轮旧适配器的干净工作区检查在模型调用前退出，0 次请求、$0，原重放 0 分保留。现用临时 index 记录实际初始文件树，结束时提取相对变化，保持 HEAD、原 index 和原文件。5 项回归通过，真实同镜像双容器验证空补丁、文本、新文件与既有未跟踪二进制的精确重放；格式、所有权、diff 检查通过，证据 `campaign/validation-35-initial-state-validation.json`。第 35 轮唯一执行代码变化为 `repository_agents.py`；双方产品归档及原始官方任务相同。

第 31 轮 Codex 原生 `turn.failed` 被内层 Bash 管道吞掉退出码，外层错误地显示成功；官方重放为 0 分。该次 37 个上游请求、436.844519 秒、已知费用下界 $0.7085059，最后一笔未知用量，整次费用未知。原始数据与诊断保留于 `campaign/validation-31-codex-terminal-failure-diagnosis.json`；重新分析报告 `sol-scriptact-codex-validation-31-report.{json,md}`。

本次修复：超时 Bash 传递 pipefail；网关分别返回请求校验 400、预算耗尽 429、上游传输 502、超时 504，记录受限错误标识并保留未知费用预占；报告识别历史原生失败，保留官方分数及原异常字段。4 项退出码/补丁测试、14 项网关等测试、38 项报告/指标测试通过，格式、模块所有权和 diff 检查通过。证据 `campaign/validation-32-harness-validation.json`。

固定 CLI 的断网容器探针复现旧配置 7 次 WebSocket 握手失败后 HTTP 回退。按官方 provider 配置显式使用 Responses HTTP 后，1 次 POST、原生正常完成、0 次握手。证据 `campaign/validation-32-transport-validation.json`。旧第 25、27 轮原生确实正常结束，但包含该回退开销，原始耗时保持，不用模拟探针时长修正。旧版 CLI 禁止覆盖内置 provider ID，探针验证使用独立 provider ID；配置见本轮清单。

修复与传输探针均新增 0 次模型调用。网关受控重启前后账本逐字相同，证据 `campaign/validation-32-gateway-restart.json`。

## 第 32 轮真实结果与环境修复

Codex 原生正常结束，102 次模型请求、908.935501 秒、费用 $2.1441003，全用量已结算，模型请求累计 877.666980 秒，缓存命中率 98.63%。原官方判分 0，15 项测试通过、2 项出现同一本地 TLS bad record MAC。官方参考解法在同一环境也得到相同结果。

独立断网探针确认 Go 1.16.15 的 AES/TLS 默认路径通过，而 ChaCha20 路径失败；仅设置 `GODEBUG=cpu.avx2=off` 后 100 次 TLS 往返通过。相同环境修复使官方参考解法及既有 Codex 补丁的官方验证均恢复到 1 分，模型调用增加 0，源补丁逐字不变。诊断与证据 `campaign/validation-33-rosetta-go-tls-validation.json`；修正重放 `campaign/validation-32-teleport-codex-replay-avx2-off.json`。

所有原始 0 分、源耗时与费用保留。Codex 源运行未带兼容配置，因此本题时间/费用仅为历史诊断参考，不能用来宣称严格同环境效率领先。后续新题在双方付费前先做官方参考解法的零模型环境预检，再冻结同一执行配置。

## 第 33 轮结果与封存

ScriptAct 源任务和官方全新容器重放均无异常，原生状态 completed，reward=1。28 次请求均为 GPT‑6 Sol high、用量完整；解题 607.365077 秒、整次费用 $1.0157946，官方 verifier 104.807178 秒，端到端 756.284073 秒。报告 `sol-scriptact-codex-validation-33-report.{json,md}`；终态诊断 `campaign/validation-33-scriptact-final-diagnosis.json`。

51 次独立工具调用、32 段脚本，没有协议拒绝或完全相同的重复 Shell 命令。两次编译错误在本次任务内修复，现有证据不支持归因为框架缺陷。模型请求累计 374.20 秒，脚本累计 208.93 秒，上下文准备 4.84 秒，轨迹导出 14.40 秒 / 累计写入约 1.04 GB；计时边界不同，不能直接相加。输入峰值 91,886 token，缓存命中率 86.59%，没有上下文整理模型调用。

第 32 轮 Codex 的既有补丁在修正环境后同样通过。其历史源指标为 102 次请求、908.94 秒、$2.1441003，但源环境不同，不能据此宣称严格效率胜出。保持当前成功候选，下一道新题在环境预检通过后比较完整请求、总耗时和整次费用。

- 清单 `campaign/scriptact-codex-validation-33.json`，SHA-256 `b635586b1ac517c30a9f4370c4811485ce42e46515ecaaf977b09ac1fc526402`。
- 任务：`instance_gravitational__teleport-db89206db6c2969266e664c7c0fb51b70e958b64`，原验证组位置 5。
- 唯一付费尝试：`sol-repository-validation-33-scriptact-1`，源任务后接同名 `-replay` 官方新容器验证。
- 共用 `execution_env={"GODEBUG":"cpu.avx2=off"}`，启动器应用到源 Agent、重放 Agent 和 verifier。环境冲突拒绝启动；报告拒绝将不同 execution_env 的历史源作为同协议效率对照。13 项相关回归、格式和模块所有权通过。
- ScriptAct `.velaros-workspace/bench/bundle-sol-raw-output-v1`，候选指纹 `b2405693f7ce47c699d15073a0f04aac1a0a1aac8926448005b6e0185abac5de`，Linux 归档 SHA-256 `ec36062666600f717d3b67dfb5b46254b75f3b1e0e2decc146e32ace5af663e6`。
- 候选启用项目图片能力，常驻 `shell.run` 与 `project.edit` 正式声明；完成控制行先于总结，长文本在现有展示预算下提供正文片段，普通大结果从完整归档投影。
- 产品候选自第 31 轮起保持原样。20 个执行文件中相对第 32 轮仅启动器增加共享执行环境接入；完整任务、依赖、镜像及参与方包摘要核验通过，证据 `campaign/validation-33-pre-dispatch-freeze.json`。

产品修复的离线证据：`campaign/raw-output-31-local-validation.json`（79 项测试）、`campaign/structured-output-30-local-validation.json`、`campaign/completion-first-29-local-validation.json`、`campaign/selected-contracts-28-local-validation.json`。完整输出归档保持；真实效率收益待多题验证。

## 历史已测结果

Element Web 同题官方 reward 均为 1，原生正常结束：

| 候选                                  | 请求数 | 解题秒数 |       费用 | 含官方验证秒数 |
| ------------------------------------- | -----: | -------: | ---------: | -------------: |
| Codex 0.158.0 第 27 轮                |     24 |   368.34 | $0.4595711 |         447.83 |
| ScriptAct request-economy 第 27 轮    |     21 |   418.56 | $0.6741738 |         498.87 |
| ScriptAct selected-contracts 第 28 轮 |     18 |   321.24 | $0.4508068 |         403.59 |

这是已观察任务的修复结果；第 27 轮请求更少却更慢、更贵，说明只降请求数不足以证明效率提高。第 28 轮三个指标下降，但 Codex 含已发现的网关协议回退开销，且费用差距较小，不能据此证明总体领先。数据全部保留，新协议另测。完整历史见 [REPORT.md](REPORT.md)。

## 当前后续工作

1. 本地实现验收与历史证据边界已汇总到 [第 49 轮处理结果](LOCAL-FIXES.md)。新的模型行为结论须来自后续授权的真实运行，当前保留待测状态。
2. 原始任务、固定顺序与历史环境差异保留；当前只分析既有记录和本地实现，不派发源任务、Oracle、重放或模型请求。
3. 原验证组与 HARD-51 的覆盖缺口作为证据边界记录，不将现有单题或多个不同版本合并成当前候选总胜率。

## NodeBB 准备证据

1. NodeBB 准备控制器 **45979** 已完成并退出 0，阶段记录 `campaign/validation-34-preparation-controller-2.json`。第一段 **92894** 在期限后保留连续进度；第二段所在控制器 **76131** 已于 07:50 UTC 停止，211 MB 层完整校验成功，下一层连接超时而停止，新增模型调用 0。第三段采用最多 16 个镜像传输、1,800 秒派发期限，完整 SHA 校验、原始 OCI 导入、官方参考验证、清单封存及双方安装检查均成功。23 个压缩层和 23 个解压摘要一致，实际 Linux AMD64 镜像身份通过，官方参考解法 reward=1，两次安装均无异常；全流程模型请求计数保持 1,375。
   中断恢复时确认原网关进程消失、端口和空锁均无持有者，归档空锁后重启；账本逐字一致，证据 `campaign/validation-34-gateway-recovery.json`。旧固定 DNS 地址的当前探针连接超时，当前地址与系统解析返回逐字匹配的 256 KiB；第三段改为每次传输使用系统 DNS。另从原始 HTTP 206 记录恢复 15 个带大小和 SHA 证据的分段，共约 7.5 MB，原文件保留，完整层摘要仍必须通过。修复与证据 `campaign/validation-34-recovery-validation.json`；当前可达性不能单独证明全部历史超时原因。
   此前单连接下载 **90720** 在本任务进程组核验后受控中断，原始终态与切换证据保持。准备记录 `campaign/validation-34-nodebb-preparation.json` 在官方预检前固定了双方候选和 10 个原始任务文件身份，进度 `campaign/validation-34-progress.json`。提前封存的真实调用已正确拒绝缺少镜像完成证明，新增模型调用 0，证据 `campaign/validation-34-premature-freeze-guard.json`。
   小型传输对照中 HTTP/1.1、HTTP/2 和默认 DNS 的已知 1 MiB 正文都逐字匹配，速率相近；整层镜像代理下载也在 45 秒内仅收到部分正文，未发布到共享缓存。证据分别为 `image-imports/nodebb-validation-34-transport-probe/result.json`、`image-imports/nodebb-validation-34-mirror-whole/result.json`，没有协议切换收益证据。下载完成后以新的 `nodebb-validation-34-ready` 目录执行原始 OCI 导入；`probes/nodebb-34/freeze-pair.py` 仅在镜像 23 层验证、官方参考 1 分、零新增模型请求、原任务与双方候选身份一致时创建第 34 轮双参与方清单。该准备脚本已通过语法检查和实际运行，已生成第 34 轮清单。
   脚本使用 `.velaros-workspace/bench/venv/bin/python`。上述 `campaign/`、`probes/`、报告与镜像证据均位于 `.velaros-workspace/bench/`。不提交或推送，不改写已封存候选、清单及原始任务结果。
