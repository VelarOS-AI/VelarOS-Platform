# Velaros 装配不变量

| 编号 | 承诺 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 模块发现、脚本调用、上下文提交和重启恢复复用共享主干 | 测试 | test/platform.test.mjs |
| INV-2 | 文本 observe/execute 与宿主 script 共用程序校验，内部模块及持久源码分页读取共用注册表 | 测试 | test/runtime.test.mjs |
| INV-3 | 基础契约超窗明确阻塞，截断响应不执行 | 测试 | test/runtime.test.mjs |
| INV-4 | 14 个生成领域合同与 99 个操作复用同一注册、声明、schema 和调用链 | 测试 | test/platform.test.mjs |
| INV-5 | 自动保存脚本可在重启后按当前会话引用执行，源码版本与执行身份分别记录 | 测试 | test/platform.test.mjs |
| INV-6 | 当前投影包含有效观察、结果租约与分别记录的源码/输出变化；程序状态索引与任务边界同版本，增量发布保持占位唯一和原子回滚 | 测试 | test/program-context.test.mjs、test/context-index.test.mjs |
| INV-7 | 真实图像持久保存并以图像块经共享编译器发送 | 测试 | test/platform.test.mjs |
| INV-8 | 精确编辑全成或全不成，检查失败保存可修复草稿，旧观察基线不得覆盖新版本 | 测试 | test/incremental-edit.test.mjs |
| INV-9 | 同次提交全部候选先检查，源码、观察更新和执行占位原子提交；重试不重复执行，未决状态要求核对 | 测试 | test/incremental-edit.test.mjs |
| INV-10 | 有限结果租约只按本帧实际投递且身份相同的租约消费，分页读取与续租不会重新执行原脚本；文本执行默认 segment 期限，结果随历史封段时退役，显式期限优先，主动释放立即生效，任务结束释放 segment 与 task 租约 | 测试 | test/program-context.test.mjs、test/text-decoder.test.mjs、test/text-runtime.test.mjs、test/context-management.test.mjs |
| INV-11 | 观察增量编辑默认绑定本轮展示版本；合并提交检查失败不改变观察或执行世界操作 | 测试 | test/script-submission.test.mjs |
| INV-12 | 任意流分片和原文边界得到相同解析，未知声明或未闭合段不派发；工作指令从本帧允许的控制头开始，缺少工作决策时，修复提示给出当前帧标记及本作用域允许的控制头；未闭合提示给出精确闭合行并要求完整重发，修复后整批只执行一次 | 测试 | test/text-decoder.test.mjs、test/text-runtime.test.mjs |
| INV-13 | 多执行身份独立；异步按额度调度；done 等待结果；取消及恢复不盲重放 | 测试 | test/text-runtime.test.mjs |
| INV-14 | 用户图片、冻结宿主参数与原文在真实 runner / provider 编码中保真 | 测试 | test/text-runtime.test.mjs |
| INV-15 | 段、卷与历史目录遵守当前授权代次；封卷留下最近响应，被封的原文仍可分页召回；卷写入后不再修改，目录逐级合并且条数有界；不可变结果分类缓存有界、重置换代清空、正文缺失不缓存；旧检查点只迁移一次 | 测试 | test/context-management.test.mjs、test/context-index.test.mjs |
| INV-16 | 长轮次 Runtime 视图不累积过期结果；释放租约仍可召回不可变原文 | 测试 | test/context-management.test.mjs |
| INV-17 | 搜索关闭前保持 claim 和能力范围；清理逐项尝试，失败可见；父租约释放前等待搜索与子模型账务结算 | 测试 | test/advanced-search.test.mjs |
| INV-18 | 所有正式会话使用同一五分区组装器；历史正文只发送一次，结果关联源码和原生图像保持可用；各投影阶段可用一致索引快照且不改写历史 | 测试 | test/context-memory.test.mjs、test/context-index.test.mjs |
| INV-19 | 笔记更新使用版本 CAS，观察不可修改；移出仅改变驻留，授权重置后旧引用不能绕回；索引快照与增量提交保持相同竞争和授权语义，目录按键取最新而旧笔记仍可按引用召回；单条材料召回不依赖无关笔记正文，目录分页保持重附授权与筛选尾页 | 测试 | test/context-memory.test.mjs、test/context-index.test.mjs |
| INV-20 | 卡片与正文按恢复窗口裁剪；维护轮可整理笔记但不重放观察或业务；子任务拥有独立工作区 | 测试 | test/context-memory.test.mjs |
| INV-21 | 容量省略不触发完成空转，新到达结果补投递；运行中续租仍保持新曝光次数 | 测试 | test/context-memory.test.mjs |
| INV-22 | 输出整理修改源码中的声明式 view 与预算，按同一 CAS 发布；本轮复用原始结果，采集与展示版本分别可见，下一正常轮才刷新 | 测试 | `test/output-context.test.mjs` |
| INV-23 | 原始块、失效摘要、缺失输出和原生图片有独立状态；源码或用户变化拒绝旧补丁，失败补丁不留下部分元数据 | 测试 | `test/output-context.test.mjs` |
| INV-24 | 读到的资源版本不进帧、不挡写入、也不打回收尾（ADR 0025）：帧里的 decision 只有收尾要等的缺口；资源是不是变了由各领域写入时自己的版本核对管；Kernel 的读取凭据照旧可以核验（伪造、撤权、换代） | 测试 | `test/decision-basis.test.mjs` |
| INV-25 | required 输出没完整可见时收尾要等它补齐（写入照常）；整理候选先校验再 CAS，取消阻止迟到发布；派生展示在任务内保留，策略变化重建段底座；整理没解决的超载同段不再重复 | 测试 | `test/decision-basis.test.mjs`、`test/context-maintenance.test.mjs`、`test/output-context.test.mjs` |
| INV-26 | continue 累计任务身份和配额；new 归档并切换驻留状态，未决效果阻止切换 | 测试 | `test/task-lifecycle.test.mjs`、`test/model-tools.test.mjs` |
| INV-27 | 观察健康状态持久化，重复失败或未知效果暂停自动重跑；源码修复后才能恢复 | 测试 | `test/task-lifecycle.test.mjs` |
| INV-28 | 完成拒绝按恢复类别有界推进；效果不明的操作（包括子任务的）不挡写入、完成与任务切换；上次中断的执行在下一轮开始前自动按日志收拾，不重跑脚本 | 测试 | `test/completion-recovery.test.mjs`、`test/act-children.test.mjs` |
| INV-29 | 搜索、子任务、整理使用统一交付清单；共享材料保留原始指纹，源码复用经过调用者自身校验与权限 | 测试 | `test/advanced-search.test.mjs`、`test/model-tools.test.mjs`、`test/context-maintenance.test.mjs` |

| INV-30 | 声明式入口复用唯一主干；路径与重复挂载在执行前校验；关闭重开与初始化重试恢复持久状态 | 测试 | `test/runtime.test.mjs` |
| INV-31 | 支线关闭后仍可分页读取真实请求及回执；跨根归属拒绝，正文截断明确 | 测试 | `test/act-children.test.mjs` |
| INV-32 | 连续 80 次真实状态推进与 82 次模型回合保持观察正确、请求有界、磁盘可恢复 | 测试 | `test/runtime.test.mjs` |
| INV-33 | 搜索已读证据目录不依赖执行结果租约；遵守预算并在新请求前移除失效版本 | 测试 | `test/advanced-search.test.mjs` |

| INV-34 | 整理输入原文直接进入有界事实区；只有响应接纳后确认的完整分页范围才能支持输入摘要，候选编译与隐藏读取不计入 | 测试 | `test/context-maintenance.test.mjs` |
| INV-35 | 收尾请求按预留窗口编译；成功只读及已成功提交的同类回执可跨执行按次数与首尾 ID 展示，失败、部分提交与未知效果逐条保留；原始回执与完成决策校验保持完整 | 测试 | `test/advanced-search.test.mjs`、`test/context-memory.test.mjs`、`test/runtime.test.mjs` |
| INV-36 | 最近一次脚本失败的关键诊断在正文被引用化后仍进入有界状态区，后续成功执行清除旧错误，完整回执继续可召回 | 测试 | `test/context-memory.test.mjs` |
| INV-37 | 注入 ContextStorage 时可在禁用 SQLite 的进程中完成正式模型回合、项目修改、下一轮观察、追踪和会话重开；不创建隐式 SQLite | 测试 | `test/runtime.test.mjs` |

| INV-38 | 实时与持久事件共用正文投影；接纳按回合去重，拒绝、错误、终态及交付结束清除预览，迟到文本不能复活正文候选 | 测试 | `test/act-children.test.mjs` |

| INV-39 | 会话工作区在 ContextStorage 中原子固定，重开与并发绑定核对真实路径；能力开关保持绑定，旧绑定损坏或范围变化拒绝激活 | 测试 | `test/runtime.test.mjs` |

| INV-40 | 宿主事件先持久化再按序交付，写入可合批；收尾等待全部在途写入，失败停止后续交付并向调用者保留首个错误 | 测试 | `test/event-delivery.test.mjs` |
| INV-41 | 默认效果串行；宿主声明的完整资源集合仅在互不冲突时并行，未知范围形成全局屏障；取消等待者不释放活动效果 | 测试 | `test/effect-scheduler.test.mjs`、`test/text-runtime.test.mjs` |
| INV-42 | 诊断计量不含正文且不改变存储能力、错误或执行结果；观察者异常与异步拒绝被隔离，历史未计量回合返回 null | 测试 | `test/runtime-diagnostics.test.mjs`、`test/trace-index.test.mjs` |

| INV-43 | 可信宿主产品指令进入主会话真实请求、协议修复与追踪，并参与发送前预算；重开使用当前设置，非法配置拒绝激活 | 测试 | `test/host-instructions.test.mjs` |

| INV-44 | 实时与持久事件共用回合、状态和输入回执投影；回合身份去重，消费按归档引用区分，终态与断流不推断保留，协议拒绝不等于运行失败，error 之后有回合被接纳即清除失败原因 | 测试 | `test/run-projection.test.mjs` |

| INV-45 | 执行展示只来自 Kernel 原始调用与回执；缺失终态保持 pending，外部效果独立表达，参数和结果预览计入追踪总正文预算，身份不受正文截断影响 | 测试 | `test/execution-presentation.test.mjs` |

| INV-46 | 封存请求展示来自完整审计，媒体正文省略且显式标记；缺失计量为 null，截断不改变身份，常规展示正文计入 trace 总预算，宿主 fullContent 按回合分页保留全文，关闭后可无模型读取 | 测试 | `test/request-presentation.test.mjs` |

| INV-47 | 宿主笔记读写与模型共用版本和上下文投影；移出与恢复只改驻留，冲突不覆盖正文，重开与分页读取不调用模型，关闭后拒绝访问 | 测试 | `test/host-notes.test.mjs` |

| INV-48 | 目标跨运行与重启保留，暂停不会因新消息恢复；活动目标阻止提前完成，只有带依据的 `done` 在其余完成检查通过后结束它；随提交交来的目标在首帧读取之前写入，不覆盖推进中、暂停或受阻的目标；取消运行保持目标，旧版本不覆盖新目标，删除墓碑不会复活 | 测试 | `test/goals.test.mjs` |

| INV-49 | 同一段内，除显式有限租约到期、主动释放和底座重建外，已交付的响应与执行结果正文逐字复用；segment 正文不受本帧新投影的条数限额影响，完整请求仍核对容量；历史末尾及最早活跃租约之前最后一条结果消息标记缓存点 | 测试 | `test/context-index.test.mjs`、`test/text-runtime.test.mjs` |
| INV-50 | 封段不调用模型：切点之前封成卷并释放其 segment 租约，最近记录和显式跨段租约继续交付；按剩余轮数触发，长跑中每帧都在窗口内，观察结果跨段保持正确，原文可召回且生产操作不重跑 | 测试 | `test/context-memory.test.mjs`、`test/context-management.test.mjs` |
| INV-51 | 主线到回合或墙钟上限时封段续跑、发 renewed，运行不结束；墙钟到点后再过一个周期仍没走到轮边界就照旧取消；本次运行连续没有进展时先提示、再要求反思、到 9 步暂停等用户，新的输入重新起算 | 测试 | `test/act-run.test.mjs` |
| INV-52 | 段底座带三张长期单：否定尝试跨卷累积去重、未解问题取最新写下的叙事、用户约束取输入摘要，各有条数上限，超出只计数并保留出处；段起点之前的目标在底座列第一行，最新和段内新提目标按原选择预算交付正文，动态帧保留它们的当前范围 | 测试 | `test/context-memory.test.mjs` |
| INV-53 | 自动封成的一卷至少六轮、那一段又没改笔记和计划时，下一个请求边界由整理支线补写叙事，每卷最多一次、不认领显式整理请求；叙事和长期单随下一次底座重建进入请求 | 测试 | `test/context-management.test.mjs` |
| INV-54 | 读回上一帧因容量不够只给了引用的笔记或没排进本帧的租约结果记一次缺页（同一帧同一份只记一次，派生展示主动移出的不算）；封段时按缺页调整下一段的笔记份额，没有缺页就回落到宿主配置 | 测试 | `test/context-memory.test.mjs` |
| INV-55 | 写操作失败时，错误（或它 cause 链里的任一层）带着「没有写入」约定标记——`effect: 'none'` 或 `executionOutcome: 'not-applied'`——就记成没有效果；两样都不认的写失败仍是效果未知，照实给模型看 | 测试 | `test/platform.test.mjs` |
| INV-56 | 工作区项目可以另挂 velaros:code 与 velaros:images：都用运行时自己的项目内核；看图钳在项目里，出了项目那一张报 PERMISSION；没有代码图谱后端时语言服务照常答、图谱类分析报 UNAVAILABLE；不给 project 选项时两件都不挂 | 测试 | test/platform.test.mjs |
| INV-57 | 运行说明列出本会话其余能 import 的模块，每个带模块目录里的一句简介（模块声明开头那段说明的第一句）；常驻的与 velaros:system 的成员不重复列；`modules.list` 的卡片 summary 也是这句，而不是模块名本身 | 测试 | test/host-instructions.test.mjs |
| INV-58 | 普通执行输出的大数组和长文本在预算内保留带来源位置的原文片段；已截断的旧预览从 output 或 rawValue 归档重新投影，诊断保留，路径对应真实原值；小元数据只占实际大小，片段明确标记范围与省略；投影保持有效 JSON、字符硬上限和完整归档，真实下一轮请求可见片段；按 JSON Pointer 直接分页补读已授权执行字段，字符串保持原文、其他值保持 JSON，释放展示后仍可读，授权重置后拒绝，召回不重跑脚本 | 测试 | test/output-context.test.mjs、test/context-memory.test.mjs |
| INV-59 | 供应商延续状态仅随完整原始 assistant 历史恢复；冻结与重启保持相同正文和状态，封段切点前及授权重置前的状态不再投影，摘录不带状态，模型笔记或孤立状态不能加入历史 | 测试 | `test/context-management.test.mjs` |
| INV-60 | 固定协议语法置于会话稳定系统前缀，动态帧保留实际控制示例、完成条件和输入引用；跨轮前缀不随标记和输入变化，同帧修复保持控制身份和输入快照，自定义声明按许可执行且校验前不产生写效果 | 测试 | `test/text-runtime.test.mjs` |
| INV-61 | 领域调用诊断独立于脚本所选 output 进入下一轮模型材料，成功回执聚合不能丢诊断；执行与观察均保留真实成败和效果，重启不重复调用，正文明确为观察数据并遵循结果可见租约 | 测试 | `test/program-context.test.mjs`、`test/context-memory.test.mjs` |
| INV-62 | 启用段内历史时，选中用户输入正文按原始序号与响应、结果合并，正文和选取范围不变则逐字复用；动态帧只列身份、范围和当前运行归属，审计帧保留原正文；后续改题排在先前响应之后，重启、任务切换、授权重置、截断和封段遵循原有边界；零历史模式仍在帧尾交付，完整模型请求核算全部内容 | 测试 | `test/context-memory.test.mjs`、`test/act-run.test.mjs`、`test/context-management.test.mjs` |
| INV-63 | 原文块与程序块分别闭合；在上一段闭合前出现下一控制头仍拒绝整份响应，错误包含当前声明名、精确闭合行和完整重发要求，支持自定义声明名且不回显原文；同帧修复前不执行任何先前合法块，修复后按完整响应执行一次 | 测试 | `test/text-decoder.test.mjs`、`test/text-runtime.test.mjs` |
| INV-64 | 完整诊断只在结果首次进入历史且正文余量足够时独立附加并冻结；仅身份、状态、效果、错误码和正文指纹完全匹配才在动态帧使用历史引用，审计保留原文；变化、未知状态或效果、旧历史无交付记录、容量不足和零历史时完整回退，脚本输出不能冒充宿主诊断；重启逐字复用且不重跑操作，封段、释放及授权重置遵循结果边界 | 测试 | `test/context-memory.test.mjs`、`test/program-context.test.mjs` |
| INV-65 | 模型工作帧仅在编码更短时汇总同类已成功只读或已提交回执，诊断、失败、部分效果、未知状态和额外字段逐条保留；连续成功作业仅在对应正文明确仍在历史时映射每个 executionId 与 resultRef，身份重复或顺序变化完整回退；活动、失败、未知与未交付正文的作业不合并，真实模型请求中的结果正文和原文召回保持可用，原始帧与历史不因展示汇总改写 | 测试 | `test/context-memory.test.mjs` |
| INV-66 | 闭合标记允许 ASCII 行尾空格，在任意流分片、LF、CRLF 和无末尾换行时得到相同结果；源码和原文空白不变，完整响应只执行一次且不增加协议修复调用；孤立闭合、非空白尾部、未闭合、嵌套和超长控制头继续拒绝 | 测试 | test/text-decoder.test.mjs、test/text-runtime.test.mjs |
| INV-67 | 常驻合同可选指定导出及其正式依赖类型，完整进入真实请求与预算，首轮即可执行；只允许已授权模块，未挂载项忽略，未知导出在请求模型前拒绝；同项去重，完整模块覆盖导出项，部分常驻模块仍可发现其他操作 | 测试 | `test/host-instructions.test.mjs` |
