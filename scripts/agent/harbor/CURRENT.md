# ScriptAct 与 Codex 对照：当前状态

第 47 轮 **field-read-v1** 修复与同题验证完成。`memory.read({ ref, pointer, offset, limit })` 可直接分页读取已授权执行归档中的字段，字符串按原文返回，其他值按 JSON 返回；省略路径时沿用整份归档读取。校验路径、范围、自有属性、任务权限与取消，旧宿主忽略路径会明确报错。模型合同、模板、字段召回示例及文档同步更新。

136 项相关回归完成，真实脚本补齐缺失代码后下一轮模型可见，既有历史稳定、源操作没有重跑。原 Navidrome 轨迹的三个尾段均一次精确补读 4000 字符，其中完整重建 93288 字符归档原需两页。该离线数据仅反映归档补读，不推导模型请求或整题费用收益。构建、格式、所有权、ESLint、自动生成合同、能力目录与 diff 检查通过。

安装控制器 **60945**、源任务和官方全新容器重放控制器 **98616** 均退出 0。全部五次原始尝试官方 reward=1，源任务与重放无异常，用量均已结算，同一初始工作树：

| 候选 | 请求数 | 解题秒数 | 整次费用 | 含官方重放秒数 |
|---|---:|---:|---:|---:|
| Codex 0.158.0 / 43 | 14 | 194.583037 | $0.2145132 | 286.311918 |
| ScriptAct output-redistribution-v1 / 43 | 11 | 231.076925 | $0.2959998 | 322.937546 |
| ScriptAct code-read-v1 / 45 | 9 | 173.061290 | $0.2428769 | 265.628376 |
| ScriptAct code-read-v2 / 46 | 11 | 213.408447 | $0.3688909 | 306.868156 |
| ScriptAct field-read-v1 / 47 | 9 | 195.277362 | $0.2962006 | 287.210244 |

本轮相对上一轮请求少 18.18%、解题时间少 8.50%、费用少 19.71%；相对 Codex 请求少 35.71%，时间高 0.36%，费用高 38.08%。相对第 45 轮请求相同、时间高 12.84%、费用高 21.96%。单题结果保留全部对照，不声明整体领先。

相关 metadata 三包测试 60.146 秒通过，gofmt 与 diff whitespace 通过；官方重放 51.549 秒。15 次宿主操作，1 次 TARGET_NOT_FOUND 精确编辑拒绝和 1 次 Shell 非零退出均计入，0 次脚本失败、0 次协议拒绝；本次未出现完全相同源码的重复执行组。实际输出 3 个 code 块，字段补读调用 **0**，因此整题改善不能归因于新补读功能。输入 237217 token、输出 9626 token，峰值 44408、缓存命中率 72.05%；模型 118.70 秒、脚本 68.69 秒，轨迹导出 0.997 秒 / 67.97 MB。

候选指纹 `4b5d3e8b1a5058dba4e9750b853ccef3d40678c57ef223451dd71953182289fe`；清单 SHA-256 `a0159c089690d17a6e677f64783d6a44fff5453e975dc19c60e64664da5b251f`。依赖锁、运行参数、展示/上下文/缓存上限及 20 个执行文件保持一致。证据：`campaign/field-read-47-local-validation.json`、`campaign/field-read-47-offline-replay.json`、`sol-scriptact-codex-validation-47-report.{json,md}`、`campaign/validation-47-read-behavior.json`、`campaign/validation-47-scriptact-final-diagnosis.json`、`campaign/validation-47-final-checks.json`。产品合同差量说明在 `probes/field-read-47/README.md`。

本轮仅新增 9 次模型请求、约 $0.2962006；累计 1620 次、已知估算 $44.1233191，保守占用 $122.8703382 / $1000，两笔历史未知用量继续预占。网关及 VM 空闲。后续先核查重叠读取与字段补读的选择成本、精确编辑失败的上下文依据，再决定局部修复和真实验证。原验证组的 Proton Alpine 环境仍待修复；独立题数保持。

第 46 轮按用户要求进行的 **code-read-v2** 同题验证完成，安装控制器 **25615**、源任务与官方重放控制器 **31575** 均退出 0。以下四次原始尝试全部官方 reward=1、原生 completed、源任务及重放无异常，同一初始工作树，全部模型用量已结算。只新增一次 ScriptAct 尝试，独立题数不变。

| 候选 | 请求数 | 解题秒数 | 整次费用 | 含官方重放秒数 |
|---|---:|---:|---:|---:|
| Codex 0.158.0 / 43 | 14 | 194.583037 | $0.2145132 | 286.311918 |
| ScriptAct output-redistribution-v1 / 43 | 11 | 231.076925 | $0.2959998 | 322.937546 |
| ScriptAct code-read-v1 / 45 | 9 | 173.061290 | $0.2428769 | 265.628376 |
| ScriptAct code-read-v2 / 46 | 11 | 213.408447 | $0.3688909 | 306.868156 |

v2 相对 v1 请求增加 22.22%、解题时间增加 23.31%、费用增加 51.88%；相对 Codex 请求少 21.43%，时间高 9.67%、费用高 71.97%。相关 metadata 三包测试 59.849 秒通过，格式及 diff whitespace 检查通过，官方重放 52.355276 秒。28 次底层操作、1 次精确编辑原文不匹配拒绝（写入前返回候选）、2 次 Shell 非零退出（工具/路径问题随后处理）、0 次脚本失败、0 次协议拒绝。模型累计 130.51 秒、脚本 73.31 秒、轨迹导出 1.351 秒 / 98.75 MB；所有失败和重试都计入完整成绩。

输出类型调整本次被部分采用：实际归档有 4 个 code 正文块，未再发生上轮对象误标 text 的脚本错误；memory.read 补读调用为 0，仍有重叠来源读取。记录的首个模型回复已经包含 4 个 execute 控制段，其中 3 段源码完全相同，另一段只输出 placeholder，额外三段执行耗时约 2.754 秒。证据属于同一模型回复内的重复程序，不能据此自动去重可能有副作用的任意脚本。

本次总输入 341,089 token、输出 10,438 token，相对 v1 增加 75.04% 和 60.81%；输入峰值 48,574，缓存命中率从 68.98% 升至 74.98%，完整费用仍上升。v2 的整题效率尚无改进证据，单次观察也不能将全部差值归因于指引修改。后续先对重复控制段和超量/重叠读取做零模型诊断，再决定产品修复与付费验证；原验证组的 Proton Alpine 环境修复仍待处理。

本轮只验证已封存包，产品代码保持；候选指纹 `b4f07706a2c518d343a8822bcd90f549089fcd00f563a6e217c9365d80515867`。清单 `campaign/scriptact-codex-validation-46.json` SHA-256 `9cf704aa76434ac70fc522432e257cf04a6850d36af4528549aa6795e30ea0fc`，全部 20 个执行文件与包身份终验相同。报告 `sol-scriptact-codex-validation-46-report.{json,md}`、诊断 `campaign/validation-46-scriptact-final-diagnosis.json`、读取行为 `campaign/validation-46-read-behavior.json`、终验 `campaign/validation-46-final-checks.json` 保留全部四次尝试。

本轮新增 11 次请求、$0.3688909；累计 1,611 次，已知估算 $43.8271185，保守预算占用 $122.326067 / $1,000，两笔历史未知用量继续预占。网关与专用 VM 当前空闲。

第 45 轮 Navidrome 同题指引优化验证已完成，控制器 **48550** 退出 0。Codex43、原 ScriptAct43、新候选45 均官方 reward=1、原生完成，源任务及重放无异常，同一初始工作树，全部用量已结算。

| 候选 | 请求数 | 解题秒数 | 整次费用 | 含官方重放秒数 |
|---|---:|---:|---:|---:|
| Codex 0.158.0 / 43 | 14 | 194.583037 | $0.2145132 | 286.311918 |
| ScriptAct output-redistribution-v1 / 43 | 11 | 231.076925 | $0.2959998 | 322.937546 |
| ScriptAct code-read-v1 / 45 | 9 | 173.061290 | $0.2428769 | 265.628376 |

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

| 候选 | 请求数 | 解题秒数 | 整次费用 | 含官方重放秒数 |
|---|---:|---:|---:|---:|
| Codex 0.158.0 | 14 | 194.583037 | $0.2145132 | 286.311918 |
| ScriptAct output-redistribution-v1 | 11 | 231.076925 | $0.2959998 | 322.937546 |

本题 ScriptAct 请求少 21.43%，解题慢 18.75%，费用高 37.99%。相关 metadata 测试 58.475 秒通过，后续修改后 FFmpeg 测试 1.847 秒通过，格式、diff 检查及补丁审阅完成。22 次工具调用、0 工具异常、0 协议拒绝；gofmt 因登录 PATH 缺失失败一次，随后恢复。双方均遇到 Go 工具路径问题。模型累计 152.06 秒、脚本 70.67 秒；轨迹导出 0.917 秒 / 63.89 MB；输入峰值 34,205 token、缓存率 67.60%。

一次批量读取返回 44,836 字符，展示上限 12,000，随后重复读取并释放 3 份旧结果。原文保持；离线 16,000 字符回放仍未让主要输出完整。当前证据支持检查读取粒度和展示效率，不能直接证明增大上限会改善整题时间与费用。诊断 `campaign/validation-43-scriptact-final-diagnosis.json`，回放 `campaign/validation-43-output-budget-offline.json`，报告 `sol-scriptact-codex-validation-43-report.{json,md}`。

累计 1,591 次调用，已知估算 $43.2153507，保守预算占用 $121.1871764 / $1,000，两笔历史未知用量仍预占。该轮完成时网关 **88860** 与专用 VM 空闲。接下来按原序准备位置 8 Proton WebClients，候选保持 output-redistribution-v1。

第 43 轮准备控制器 **34210** 退出 0，27 个压缩层及解压摘要、精确镜像身份、Oracle reward=1、双方安装均通过，准备新增 0 次调用。清单 SHA-256 `4d43761ec6ba7b9450aee2249cf95e8bd640fe3f6f7c8c9d0acdb3a8144c6133`，准备记录 SHA-256 `69de6a811e7a3a8d7e67145c1c7d9349cbcb391cb06eade7910cafa38e03fbdd`；双方 GPT‑6 Sol high，20 个执行文件相同，10 个任务文件核对原始字节。已回收专用 VM 闲置 Vuls 镜像缓存，原始产物保留。

已有原验证组首次结果索引见 `COHORT.md`，审计 `campaign/validation-43-cohort-first-attempt-audit.json`。不同候选与历史传输配置分别标注；Teleport 原源环境差异单列，原始失败与修正重放证据保持。

第 42 轮 OpenLibrary 首次独立对照完成，Codex 控制器 **52774**、ScriptAct 控制器 **20422** 均退出 0；双方官方 reward=1、原生正常，源任务和全新容器重放无异常，同一初始工作树与镜像，全部用量结算。

| 候选 | 请求数 | 解题秒数 | 整次费用 | 含官方重放秒数 |
|---|---:|---:|---:|---:|
| Codex 0.158.0 | 29 | 351.996057 | $0.4513117 | 400.379971 |
| ScriptAct output-redistribution-v1 | 11 | 237.729020 | $0.3648197 | 287.317564 |

本题 ScriptAct 请求少 62.07%、解题快 32.46%、费用低 19.16%。相关导入测试最终 102 项通过，随后聚焦文件 28 项通过，Ruff、diff 检查与补丁审阅完成。29 次工具调用，无工具异常或协议拒绝；4 次 Shell 非零退出来自任务内测试与 lint，模型已修正。模型累计 208.68 秒、脚本累计 19.88 秒，轨迹导出 1.03 秒 / 80.99 MB；输入峰值 48,301 token、缓存率 75.88%。Codex 最终相关模块 144 项通过、1 项预期失败。不同合理验证范围全部保留，各自官方判分均通过。

报告 `sol-scriptact-codex-validation-42-report.{json,md}`，诊断 `campaign/validation-42-scriptact-final-diagnosis.json`。保留第 41 轮 Vuls 退步结果；单题优势不能推断总体领先。第 42 轮完成时累计 1,566 次调用、已知估算 $42.7048377、保守占用 $120.2357304 / $1,000，两笔历史未知费用仍预占；该轮结束时网关与专用 VM 空闲；当前进展以上方第 43 轮为准。

第 42 轮准备控制器 **48271** 退出 0，24 个压缩层和解压摘要、精确镜像、Oracle 1 分与双方安装均通过，准备新增 0 次调用，下载 318.35 秒。清单 SHA-256 `f1326d8fa0f5933cb20164b1b70666221d71843b916c0a96cc45c3b04ba0b115`；准备记录 `campaign/validation-42-openlibrary-preparation.json` SHA-256 `275d3853b31844ef67884981a8e20579638a43c5c0b0f8bcbb106d31503d1966`。已回收专用 VM 的闲置 NodeBB 镜像缓存，原始镜像、结果、补丁均保持，证据 `campaign/validation-42-vm-cache-reclamation.json`。

第 41 轮 Vuls 修复验证已完成，控制器 **60316** 退出 0，官方 reward=1、原生 completed，源任务及重放均无异常。全部用量已结算，原第 40 轮双方成绩完整保留：

| 候选 | 请求数 | 解题秒数 | 整次费用 | 含官方重放秒数 |
|---|---:|---:|---:|---:|
| Codex 0.158.0 / 40 | 31 | 490.329249 | $0.585607 | 767.842741 |
| ScriptAct verification-scope / 40 | 17 | 524.739804 | $0.5199364 | 802.235255 |
| ScriptAct output-redistribution / 41 | 20 | 549.980957 | $0.6133093 | 825.167114 |

三次官方验证全部通过。新候选相对原 ScriptAct 请求增加 17.65%、时间增加 4.81%、费用增加 17.96%；相对 Codex 请求少 35.48%、时间多 12.17%、费用多 4.73%。这次展示修复有离线正确性证据，没有整题效率收益证据，不以单次已观察任务推断代码变更造成全部差异。

两个编辑拒绝均在写入前完整返回候选位置；新增测试用了不存在的类型字段，修正后相关三包测试通过，后续代码/测试修改也完成必要重跑。四次测试命令分别为 233.245 秒成功、4.121 秒编译失败、3.622 秒成功、5.188 秒成功。格式、diff 检查和补丁审阅完成。27 次工具调用、0 协议拒绝，模型累计 275.98 秒、脚本累计 264.72 秒，轨迹导出 3.46 秒 / 292.15 MB；峰值输入 63,861，缓存率 82.27%，缓存率上升而完整费用仍上升。

候选修复批量输出的闲置展示空间返还，整体预算和显式策略保持，110 项回归通过，新增 3 项修复前均失败。原输出离线对照确认两段改善：代码从 62 行到 75 行，另一个编辑回执从片段变为完整；已有完整块、原值、引用和冻结历史保持。投影 16 段的平均耗时从 13.32 毫秒增至 50.90 毫秒，计入诊断。构建、格式、模块所有权、ESLint、安装检查均通过，准备新增模型请求 0。

清单 `campaign/scriptact-codex-validation-41.json` SHA-256 `626de8a6e4bdb1df5901af95cb1761982a06b915cc56ade1d0f6d9c244a5145d`；候选 `bundle-sol-output-redistribution-v1`，指纹 `9cb584141f1ba8d6f8a30e2223b13fc5fcb28189858b6e8f24adc14db467547d`，Linux 归档 SHA-256 `8e86e5799eda9077d61ac0e035ab4676232b51a1e59299b52488f3c7a81f73f6`。正式声明、依赖锁、Runtime 设置、20 个执行文件逐字一致。产品验证 `campaign/output-redistribution-41-local-validation.json`；报告 `sol-scriptact-codex-validation-41-report.{json,md}`，终态诊断 `campaign/validation-41-scriptact-final-diagnosis.json`。

第 41 轮结束时累计 1,526 次模型请求，已知估算 $41.8887063，保守预算占用 $118.7274626 / $1,000，两笔历史未知用量继续预占。该轮结束时网关 **88860** 与专用 VM 空闲；当前进展以上方第 42 轮为准。

第 40 轮清单 SHA-256 `accafd5d595a83b243a74b1aba86dc1a4c8527c65125c47d1ed98610252f25d5`。双方在 Oracle 前固定为 Codex 0.158.0 和第 39 轮 verification-scope-v1，20 个执行文件与上一轮逐字相同。准备记录 `campaign/validation-40-vuls-preparation.json`，SHA-256 `2e4817c04fb25c543c423fa46f5f3e2d9310df686b5e8028e1495eb424ff3a56`；10 个官方文件核对 Git 原始字节。已回收专用 VM 中已完成 Teleport 的闲置镜像，可用空间恢复到约 10 GiB，证据 `campaign/validation-40-vm-cache-reclamation.json`。

登录环境兼容性核对 `campaign/validation-40-login-compatibility-review.json` 确认核心平台和共享环境均明确采用登录语义；后续环境优化须处理配置优先级。当前沿用已封存 Shell 行为，通过新题检验当前候选。

第 39 轮验证范围优化已完成：ScriptAct 源任务和官方新容器重放均正常，reward=1，控制器 **93454** 退出 0。保留第 38 轮 Flipt 新题双方原始基线，控制器 Codex **92279**、ScriptAct **39650** 均退出 0；同一初始树、镜像、资源、执行环境，三次尝试全部用量已结算。

| 候选 | 请求数 | 解题秒数 | 整次模型费用 | 官方验证秒数 | 含重放秒数 |
|---|---:|---:|---:|---:|---:|
| Codex 0.158.0 / 第 38 轮 | 20 | 415.794772 | $0.3138522 | 85.778561 | 541.610532 |
| ScriptAct redis-daemon / 第 38 轮 | 9 | 540.835293 | $0.2793824 | 87.098601 | 669.154429 |
| ScriptAct verification-scope / 第 39 轮 | 7 | 373.450808 | $0.2210531 | 85.483525 | 499.599353 |

第 39 轮相对原 Codex：请求少 65%、解题快 10.18%、费用低 29.57%，三个主指标均改善；含官方重放总时间也更低。相关测试、调用方编译、格式、diff 检查、补丁审阅及官方独立判分通过。这是已观察任务的一次优化验证，不能推断总体领先，也不能把全部差值归因于提示调整。第 38 轮原 ScriptAct 请求少 55%、费用低 10.98%，解题慢 30.07%，原结果保持。模型阶段累计 168.03 秒对 224.23 秒；ScriptAct 脚本累计 364.40 秒。相关 Go 测试已通过（235.531 秒）后又跑全仓库测试（73.606 秒），Redis testcontainers 因沙箱内没有 Docker daemon 失败；随后排除该包重跑 5.232 秒，相关包 vet 加 diff 检查 41.422 秒。所有时间、失败及环境限制均保留。两边均遇到 Go 不在 PATH 并自行找到安装路径。没有新的协议拒绝、工具调用异常或结果遗漏。

第 39 轮通用指令根据改动、受影响调用方和项目要求确定必要检查，扩大或重复验证需有具体依据，环境失败保持可见。构建、格式、所有权、ESLint 和 41 项现有回归通过；包差异仅工作指令、其 source map 和身份，依赖锁、Runtime 配置、上下文与缓存政策相同。安装预检 **56486** 退出 0，准备新增 0 次模型调用；真实源任务 7 次请求、全部完成，官方重放 reward=1。

实际轨迹：14 次工具调用，0 工具异常、0 协议拒绝。修改、格式和相关 Go 测试合并在同段执行，相关测试 230.409 秒通过；随后检查 diff 与补丁。模型累计 129.32 秒、脚本累计 236.85 秒、上下文准备与轨迹导出单列于报告。峰值输入 33,831 token，缓存命中率 65.02%，Codex 为 93.15%；缓存率更低但完整费用更低，主指标保持整次任务口径。

第 39 轮清单 SHA-256 `5b6950bb4da53981576192b93d51735d44f61d99ec0fe1b4665aea8ec1b19117`；候选 `bundle-sol-verification-scope-v1`，指纹 `22a97d61b78f6a3989ec5aa9fc906ec175302c603845cd13a80c193b7d21af46`，Linux 归档 SHA-256 `90e960dc9869088c31d0bb7d047ac8f85dfe3f83b5656eb882c33d811a8f85c6`。报告 `sol-scriptact-codex-validation-39-report.{json,md}` 保留原始双方及新候选，诊断 `campaign/validation-39-scriptact-final-diagnosis.json`。

第 38 轮报告 `sol-scriptact-codex-validation-38-report.{json,md}`，诊断 `campaign/validation-38-scriptact-final-diagnosis.json`。第 39 轮后累计 1,458 次模型请求，已知估算 $40.1698536，保守预算占用 $115.4894822 / $1,000；两笔历史未知用量保持预占。网关 **88860**，该轮完成时专用 VM 与网关空闲；当前进展以上方第 42 轮状态为准。

第 38 轮清单 SHA-256 `04a64ba6ec94a22b527e031bbc9920bc530ea49332cc469f4e66ce3cc96c530c`。原组位置 3，首次付费对照；镜像 21 层及解压摘要、官方 Oracle 1 分、双方安装均验证通过，准备新增 0 次模型调用。原候选 `bundle-sol-redis-daemon-v1` 指纹 `3d0a9f45c0cd95f38ac525453233fa88847cdf78b3e27de8ca6a89c0842b6f62`。

第 37 轮 NodeBB 修复验证已完成：查询 `command -v/-V` 返回真实路径，`redis-server --daemonize yes` 后的测试链在同次调用返回退出码及完整结果。107 项回归通过、6 项平台条件跳过，实际镜像零模型探针和真实任务验证通过。各次 reward 均为 1，原始 Codex 基线只运行一次：

| 候选 | 请求数 | 解题秒数 | 整次模型费用 | 含重放秒数 |
|---|---:|---:|---:|---:|
| Codex / 第 35 轮 | 17 | 153.489634 | $0.2966446 | 231.185138 |
| ScriptAct raw-output / 第 35 轮 | 10 | 182.810119 | $0.2798079 | 262.309702 |
| ScriptAct command-lookup / 第 36 轮 | 10 | 144.144080 | $0.2447798 | 221.896470 |
| ScriptAct redis-daemon / 第 37 轮 | 10 | 134.107366 | $0.2709675 | 213.495601 |

第 37 轮较 Codex 请求少 41.18%、解题快 12.63%、费用低 8.66%；相对第 36 轮更快但费用增加。保留所有版本，这是已观察题目的修复验证，不能推断总体领先。

## 优化与比较规则

统一 GPT‑6 Sol high，对照 Codex 0.158.0。相同任务正确完成和必要验证是前提；优化完整模型请求数、解题墙钟时间和整次任务费用，同时记录官方验证及端到端耗时。一次请求塞入更多信息如果让总耗时或费用变差，不算整体改进。缓存命中率、token、上下文和工具调用用于解释原因；每次改动需验证实际收益。

先修复已定位的问题，再付费验证。全部拒绝、重试、整理、失败及未知费用保留。每个封存参与方一次，不按结果选择最好尝试。同题产品修复沿用事先指定的原始 Codex 参考。执行协议有经独立复现的缺陷时，修复后另建明确的协议与任务记录，保留原失败及费用，不能冒充新题或覆盖原成绩。

API 总预算上限 $1,000。第 39 轮完成后：1,458 次请求，已知估算 $40.1698536，保守预算占用 $115.4894822；两笔历史未知用量继续预占。运行中以网关 health 为准。一次仅一个付费任务、一个上游请求。

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

| 候选 | 请求数 | 解题秒数 | 费用 | 含官方验证秒数 |
|---|---:|---:|---:|---:|
| Codex 0.158.0 第 27 轮 | 24 | 368.34 | $0.4595711 | 447.83 |
| ScriptAct request-economy 第 27 轮 | 21 | 418.56 | $0.6741738 | 498.87 |
| ScriptAct selected-contracts 第 28 轮 | 18 | 321.24 | $0.4508068 | 403.59 |

这是已观察任务的修复结果；第 27 轮请求更少却更慢、更贵，说明只降请求数不足以证明效率提高。第 28 轮三个指标下降，但 Codex 含已发现的网关协议回退开销，且费用差距较小，不能据此证明总体领先。数据全部保留，新协议另测。完整历史见 [REPORT.md](REPORT.md)。

## 后续

1. 完成原组位置 8 Proton WebClients 的镜像准备、官方 Oracle 与双方安装预检，随后各做一次首次源任务与官方重放。控制器 68096 已因 Alpine 准备兼容问题退出，先修复并重新通过零模型预检。
2. 对真实失败或多余往返先做离线复现和修复。已证实的展示分配修复保持整体预算与原值语义，具体效率收益以整题结果为准；不能把局部多展示几行直接换算成减少模型请求。
3. 原 11 题组已有 Ansible、Element、NodeBB、Flipt、Vuls、OpenLibrary、Navidrome 独立对照和 Teleport 双方正确性验证；不同候选、传输协议及 Teleport 源环境差异分别标注，不能合并成当前候选总胜率。依次完成 Proton WebClients、Qutebrowser、Tutanota 后进入已固定顺序的 HARD-51。

## NodeBB 准备证据

1. NodeBB 准备控制器 **45979** 已完成并退出 0，阶段记录 `campaign/validation-34-preparation-controller-2.json`。第一段 **92894** 在期限后保留连续进度；第二段所在控制器 **76131** 已于 07:50 UTC 停止，211 MB 层完整校验成功，下一层连接超时而停止，新增模型调用 0。第三段采用最多 16 个镜像传输、1,800 秒派发期限，完整 SHA 校验、原始 OCI 导入、官方参考验证、清单封存及双方安装检查均成功。23 个压缩层和 23 个解压摘要一致，实际 Linux AMD64 镜像身份通过，官方参考解法 reward=1，两次安装均无异常；全流程模型请求计数保持 1,375。
   中断恢复时确认原网关进程消失、端口和空锁均无持有者，归档空锁后重启；账本逐字一致，证据 `campaign/validation-34-gateway-recovery.json`。旧固定 DNS 地址的当前探针连接超时，当前地址与系统解析返回逐字匹配的 256 KiB；第三段改为每次传输使用系统 DNS。另从原始 HTTP 206 记录恢复 15 个带大小和 SHA 证据的分段，共约 7.5 MB，原文件保留，完整层摘要仍必须通过。修复与证据 `campaign/validation-34-recovery-validation.json`；当前可达性不能单独证明全部历史超时原因。
   此前单连接下载 **90720** 在本任务进程组核验后受控中断，原始终态与切换证据保持。准备记录 `campaign/validation-34-nodebb-preparation.json` 在官方预检前固定了双方候选和 10 个原始任务文件身份，进度 `campaign/validation-34-progress.json`。提前封存的真实调用已正确拒绝缺少镜像完成证明，新增模型调用 0，证据 `campaign/validation-34-premature-freeze-guard.json`。
   小型传输对照中 HTTP/1.1、HTTP/2 和默认 DNS 的已知 1 MiB 正文都逐字匹配，速率相近；整层镜像代理下载也在 45 秒内仅收到部分正文，未发布到共享缓存。证据分别为 `image-imports/nodebb-validation-34-transport-probe/result.json`、`image-imports/nodebb-validation-34-mirror-whole/result.json`，没有协议切换收益证据。下载完成后以新的 `nodebb-validation-34-ready` 目录执行原始 OCI 导入；`probes/nodebb-34/freeze-pair.py` 仅在镜像 23 层验证、官方参考 1 分、零新增模型请求、原任务与双方候选身份一致时创建第 34 轮双参与方清单。该准备脚本已通过语法检查和实际运行，已生成第 34 轮清单。
脚本使用 `.velaros-workspace/bench/venv/bin/python`。上述 `campaign/`、`probes/`、报告与镜像证据均位于 `.velaros-workspace/bench/`。不提交或推送，不改写已封存候选、清单及原始任务结果。
