# Velaros 装配不变量

| 编号 | 承诺 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 模块发现、脚本调用、上下文提交和重启恢复复用共享主干 | 测试 | test/platform.test.mjs |
| INV-2 | 文本 observe/execute 与宿主 script 共用程序校验，内部模块及持久源码分页读取共用注册表 | 测试 | test/runtime.test.mjs |
| INV-3 | 基础契约超窗明确阻塞，截断响应不执行 | 测试 | test/runtime.test.mjs |
| INV-4 | 12 个生成领域合同与 94 个操作复用同一注册、声明、schema 和调用链 | 测试 | test/platform.test.mjs |
| INV-5 | 自动保存脚本可在重启后按当前会话引用执行，源码版本与执行身份分别记录 | 测试 | test/platform.test.mjs |
| INV-6 | 当前投影包含有效观察、结果租约与分别记录的源码/输出变化 | 测试 | test/program-context.test.mjs |
| INV-7 | 真实图像持久保存并以图像块经共享编译器发送 | 测试 | test/platform.test.mjs |
| INV-8 | 精确编辑全成或全不成，检查失败保存可修复草稿，旧观察基线不得覆盖新版本 | 测试 | test/incremental-edit.test.mjs |
| INV-9 | 同次提交全部候选先检查，源码、观察更新和执行占位原子提交；重试不重复执行，未决状态要求核对 | 测试 | test/incremental-edit.test.mjs |
| INV-10 | 结果租约只按本帧实际投递且身份相同的租约消费，分页读取与续租不会重新执行原脚本 | 测试 | test/program-context.test.mjs |
| INV-11 | 观察增量编辑默认绑定本轮展示版本；合并提交检查失败不改变观察或执行世界操作 | 测试 | test/script-submission.test.mjs |
| INV-12 | 任意流分片和原文边界得到相同解析，未知声明或未闭合段不派发 | 测试 | test/text-decoder.test.mjs |
| INV-13 | 多执行身份独立；异步按额度调度；done 等待结果；取消及恢复不盲重放 | 测试 | test/text-runtime.test.mjs |
| INV-14 | 用户图片、冻结宿主参数与原文在真实 runner / provider 编码中保真 | 测试 | test/text-runtime.test.mjs |
| INV-15 | 搜索检查点与历史目录遵守当前授权代次；容量省略仍可分页召回原文 | 测试 | test/context-management.test.mjs |
| INV-16 | 长轮次 Runtime 视图不累积过期结果；释放租约仍可召回不可变原文 | 测试 | test/context-management.test.mjs |
| INV-17 | 搜索关闭前保持 claim 和能力范围；清理逐项尝试，失败可见；父租约释放前等待搜索与子模型账务结算 | 测试 | test/advanced-search.test.mjs |
| INV-18 | 所有正式会话使用同一五分区组装器；历史正文只发送一次，结果关联源码和原生图像保持可用 | 测试 | test/context-memory.test.mjs |
| INV-19 | 笔记更新使用版本 CAS，观察不可修改；移出仅改变驻留，授权重置后旧引用不能绕回 | 测试 | test/context-memory.test.mjs |
| INV-20 | 卡片与正文按恢复窗口裁剪；维护轮可整理笔记但不重放观察或业务；子任务拥有独立工作区 | 测试 | test/context-memory.test.mjs |
| INV-21 | 容量省略不触发完成空转，新到达结果补投递；运行中续租仍保持新曝光次数 | 测试 | test/context-memory.test.mjs |
| INV-22 | 输出整理修改源码中的声明式 view 与预算，按同一 CAS 发布；本轮复用原始结果，采集与展示版本分别可见，下一正常轮才刷新 | 测试 | `test/output-context.test.mjs` |
| INV-23 | 原始块、失效摘要、缺失输出和原生图片有独立状态；源码或用户变化拒绝旧补丁，失败补丁不留下部分元数据 | 测试 | `test/output-context.test.mjs` |
| INV-24 | 实际投递材料的权威读取版本进入写门和完成检查；伪造、撤权、外界变化不能绕过，同执行写回执推进自身版本 | 测试 | `test/decision-basis.test.mjs` |
| INV-25 | required 输出必须完整可见；整理候选先校验再 CAS，取消阻止迟到发布；自动派生正文按轮过期，已验证容量在同任务内保持 | 测试 | `test/decision-basis.test.mjs`、`test/context-maintenance.test.mjs`、`test/output-context.test.mjs` |
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
