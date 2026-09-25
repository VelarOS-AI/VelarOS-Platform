# Velaros 装配不变量

| 编号 | 承诺 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 模块发现、脚本调用、上下文提交和重启恢复复用共享主干 | 测试 | test/platform.test.mjs |
| INV-2 | 文本 observe/execute 与宿主 script 共用程序校验，内部模块及持久源码分页读取共用注册表 | 测试 | test/runtime.test.mjs |
| INV-3 | 基础契约超窗明确阻塞，截断响应不执行 | 测试 | test/runtime.test.mjs |
| INV-4 | 12 个生成领域合同与 94 个操作复用同一注册、声明、schema 和调用链 | 测试 | test/platform.test.mjs |
| INV-5 | 自动保存脚本可在重启后按当前会话引用执行，源码版本与执行身份分别记录 | 测试 | test/platform.test.mjs |
| INV-6 | 当前投影包含有效观察、结果租约与分别记录的源码/输出变化；程序状态索引与任务边界同版本，增量发布保持占位唯一和原子回滚 | 测试 | test/program-context.test.mjs、test/context-index.test.mjs |
| INV-7 | 真实图像持久保存并以图像块经共享编译器发送 | 测试 | test/platform.test.mjs |
| INV-8 | 精确编辑全成或全不成，检查失败保存可修复草稿，旧观察基线不得覆盖新版本 | 测试 | test/incremental-edit.test.mjs |
| INV-9 | 同次提交全部候选先检查，源码、观察更新和执行占位原子提交；重试不重复执行，未决状态要求核对 | 测试 | test/incremental-edit.test.mjs |
| INV-10 | 结果租约只按本帧实际投递且身份相同的租约消费，分页读取与续租不会重新执行原脚本 | 测试 | test/program-context.test.mjs |
| INV-11 | 观察增量编辑默认绑定本轮展示版本；合并提交检查失败不改变观察或执行世界操作 | 测试 | test/script-submission.test.mjs |
| INV-12 | 任意流分片和原文边界得到相同解析，未知声明或未闭合段不派发 | 测试 | test/text-decoder.test.mjs |
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
| INV-24 | 实际投递材料的权威读取版本进入写门和完成检查；伪造、撤权、外界变化不能绕过，同执行写回执推进自身版本 | 测试 | `test/decision-basis.test.mjs` |
| INV-25 | required 输出必须完整可见；整理候选先校验再 CAS，取消阻止迟到发布；派生展示在任务内保留，策略变化重建段底座；整理没解决的超载同段不再重复 | 测试 | `test/decision-basis.test.mjs`、`test/context-maintenance.test.mjs`、`test/output-context.test.mjs` |
| INV-26 | continue 累计任务身份和配额；new 归档并切换驻留状态，未决效果阻止切换 | 测试 | `test/task-lifecycle.test.mjs`、`test/model-tools.test.mjs` |
| INV-27 | 观察健康状态持久化，重复失败或未知效果暂停自动重跑；源码修复后才能恢复 | 测试 | `test/task-lifecycle.test.mjs` |
| INV-28 | 完成拒绝按恢复类别有界推进；子任务未知效果向父写入、完成与任务切换传播，宿主核对不重跑脚本 | 测试 | `test/completion-recovery.test.mjs`、`test/act-children.test.mjs` |
| INV-29 | 搜索、子任务、整理使用统一交付清单；共享材料保留原始指纹，源码复用经过调用者自身校验与权限 | 测试 | `test/advanced-search.test.mjs`、`test/model-tools.test.mjs`、`test/context-maintenance.test.mjs` |

| INV-30 | 声明式入口复用唯一主干；路径与重复挂载在执行前校验；关闭重开与初始化重试恢复持久状态 | 测试 | `test/runtime.test.mjs` |
| INV-31 | 支线关闭后仍可分页读取真实请求及回执；跨根归属拒绝，正文截断明确 | 测试 | `test/act-children.test.mjs` |
| INV-32 | 连续 80 次真实状态推进与 82 次模型回合保持观察正确、请求有界、磁盘可恢复 | 测试 | `test/runtime.test.mjs` |
| INV-33 | 搜索已读证据目录不依赖执行结果租约；遵守预算并在新请求前移除失效版本 | 测试 | `test/advanced-search.test.mjs` |

| INV-34 | 整理输入原文直接进入有界事实区；只有响应接纳后确认的完整分页范围才能支持输入摘要，候选编译与隐藏读取不计入 | 测试 | `test/context-maintenance.test.mjs` |
| INV-35 | 收尾请求按预留窗口编译；成功只读回执可在模型展示中按同类计数，完整决策数据和失败及外部效果保持可核验 | 测试 | `test/advanced-search.test.mjs`、`test/context-memory.test.mjs` |
| INV-36 | 最近一次脚本失败的关键诊断在正文被引用化后仍进入有界状态区，后续成功执行清除旧错误，完整回执继续可召回 | 测试 | `test/context-memory.test.mjs` |
| INV-37 | 注入 ContextStorage 时可在禁用 SQLite 的进程中完成正式模型回合、项目修改、下一轮观察、追踪和会话重开；不创建隐式 SQLite | 测试 | `test/runtime.test.mjs` |

| INV-38 | 实时与持久事件共用正文投影；接纳按回合去重，拒绝、错误、终态及交付结束清除预览，迟到文本不能复活正文候选 | 测试 | `test/act-children.test.mjs` |

| INV-39 | 会话工作区在 ContextStorage 中原子固定，重开与并发绑定核对真实路径；能力开关保持绑定，旧绑定损坏或范围变化拒绝激活 | 测试 | `test/runtime.test.mjs` |

| INV-40 | 宿主事件先持久化再按序交付，写入可合批；收尾等待全部在途写入，失败停止后续交付并向调用者保留首个错误 | 测试 | `test/event-delivery.test.mjs` |
| INV-41 | 默认效果串行；宿主声明的完整资源集合仅在互不冲突时并行，未知范围形成全局屏障；取消等待者不释放活动效果 | 测试 | `test/effect-scheduler.test.mjs`、`test/text-runtime.test.mjs` |
| INV-42 | 诊断计量不含正文且不改变存储能力、错误或执行结果；观察者异常与异步拒绝被隔离，历史未计量回合返回 null | 测试 | `test/runtime-diagnostics.test.mjs`、`test/trace-index.test.mjs` |

| INV-43 | 可信宿主产品指令进入主会话真实请求、协议修复与追踪，并参与发送前预算；重开使用当前设置，非法配置拒绝激活 | 测试 | `test/host-instructions.test.mjs` |

| INV-44 | 实时与持久事件共用回合、状态和输入回执投影；回合身份去重，消费按归档引用区分，终态与断流不推断保留，协议拒绝不等于运行失败 | 测试 | `test/run-projection.test.mjs` |

| INV-45 | 执行展示只来自 Kernel 原始调用与回执；缺失终态保持 pending，外部效果独立表达，参数和结果预览计入追踪总正文预算，身份不受正文截断影响 | 测试 | `test/execution-presentation.test.mjs` |

| INV-46 | 封存请求展示来自完整审计，媒体正文省略且显式标记；缺失计量为 null，截断不改变身份，展示正文计入 trace 总预算，关闭后可无模型读取 | 测试 | `test/request-presentation.test.mjs` |

| INV-47 | 宿主笔记读写与模型共用版本和上下文投影；移出与恢复只改驻留，冲突不覆盖正文，重开与分页读取不调用模型，关闭后拒绝访问 | 测试 | `test/host-notes.test.mjs` |

| INV-48 | 目标跨运行与重启保留，暂停不会因新消息恢复；活动目标阻止提前完成，只有带依据的 `done` 在其余完成检查通过后结束它；随提交交来的目标在首帧读取之前写入，不覆盖推进中、暂停或受阻的目标；取消运行保持目标，旧版本不覆盖新目标，删除墓碑不会复活 | 测试 | `test/goals.test.mjs` |

| INV-49 | 同一段内，除结果租约到期、显式释放和底座重建外，连续两帧的段底座与段内历史逐字相同；段内历史第一次随已接受的帧送达后冻结；本帧尾不随段内轮数变长 | 测试 | `test/context-index.test.mjs` |
| INV-50 | 封段不调用模型：切点之前封成卷，最近记录与仍有租约的结果留给新段重新交付；按剩余轮数触发，长跑中每帧都在窗口内，观察结果跨段保持正确 | 测试 | `test/context-memory.test.mjs`、`test/context-management.test.mjs` |
| INV-51 | 主线到回合或墙钟上限时封段续跑、发 renewed，运行不结束；墙钟到点后再过一个周期仍没走到轮边界就照旧取消；本次运行连续没有进展时先提示、再要求反思、到 9 步暂停等用户，新的输入重新起算 | 测试 | `test/act-run.test.mjs` |
| INV-52 | 段底座带三张长期单：否定尝试跨卷累积去重、未解问题取最新写下的叙事、用户约束取输入摘要，各有条数上限，超出只计数并保留出处；段起点之前的任务目标只在底座列第一行，本帧尾只留最新的目标和段内新提的目标 | 测试 | `test/context-memory.test.mjs` |
| INV-53 | 自动封成的一卷至少六轮、那一段又没改笔记和计划时，下一个请求边界由整理支线补写叙事，每卷最多一次、不认领显式整理请求；叙事和长期单随下一次底座重建进入请求 | 测试 | `test/context-management.test.mjs` |
| INV-54 | 读回上一帧因容量不够只给了引用的笔记或没排进本帧的租约结果记一次缺页（同一帧同一份只记一次，派生展示主动移出的不算）；封段时按缺页调整下一段的笔记份额，没有缺页就回落到宿主配置 | 测试 | `test/context-memory.test.mjs` |
