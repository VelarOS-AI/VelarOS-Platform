# Platform 本轮差量

> 历史设计与阶段验收记录。本文中的接口、路径和测试数字对应其记录阶段；当前实现请读 [Act 运行架构](../../architecture/platform-runtime.md)、[模块规范](../../architecture/module-ownership.md)、[系统能力](../../architecture/act-system-space.md) 与 [存储合同](../../architecture/storage.md)。原始输入规格保存在 reference-pack/。

基线为本轮开始时的已有工作树；保留此前包迁移及双核实现。当前全局设计见 ../../architecture/platform-runtime.md。

## 标准工具与公开契约

| 项目 | 原因与影响 |
|---|---|
| script.run | 同一入口接受 source 或 sourceRef，支持 modules/input/blobs；自动保存并按版本复用，仍为新的执行 |
| task.inspect | 返回累计 step、独立差量与重复提示，模型能定位当前进度 |
| modules.describe | 返回与实际领域接口同源的完整声明、schema 和模板 |
| createCapabilityModule / CapabilityModuleOptions / CapabilityContext | 一次装配已有实现与宿主上下文，从领域方法推导上下文类型；不再逐方法复制合同和分发 |
| VelarosRuntimeOptions.context | 缺省 active；兼容验收显式 off，测试原有工作集承诺保持 |
| VelarosSession.run / ScriptReferenceProgram | 当前会话自动保存脚本引用成为正式输入；内部不可变原文继续复用 ContextStorage |
| OperationModuleDefinition.surface / OperationSurface | 注册时核对身份与实际操作描述，schema 扩展局部引用和元组 |
| ContextPlannerInput.task / ContextTaskFrame | 规划器和主循环使用共享用户目标、胶囊、真实回执与最近步骤 |
| ModelView.progress / ContextProgress / ContextTextChange | 分别记录源码、输出、证据和图像变化；diff 有界；连续重复 3 步提示 stalled |
| ContextStepRecord / ContextStepView | 保存附件引用；视图只展示引用与哈希，按需恢复正文 |
| ModelImage / OperationContext.attach / InvocationReceipt.attachments | 图像沿真实回执进入 Script 和 Context，结果编码失败仍保留真实效果 |
| ModelTurnRequest.images / ModelUserMessage / ModelRequestEncoderApi.messages | 编译快照和供应商使用同一多模态消息；图像纳入预算与校验 |
| CodeAttachment / CodeSurfaceOutcome | 图像类型复用 Kernel；组合结果移入 types/outcome.ts，公共导出名称不变 |
| unifiedLineDiff | 通用行差量归 Core，Script 和 Context 共用 |

## 领域操作逐项复核

以下每项均从已有 TypeScript 参数/结果生成 schema，与原实现统一装配。none 表示观察；write 表示可能产生世界效果，写入前检查与未知结果恢复适用。成功返回后的无返回值转 null、可选 undefined 字段省略；非 JSON 结果拒绝且不抹掉已提交效果。原生资源、空间和业务条件继续由原端口判断。浏览器任意 JS/CDP 按 write；可落盘截图、预览、转换按 write。

| 操作 | 效果分类 | 原接口职责 |
|---|---|---|
| velaros:files.read | none | 读文本文件：每个文件交回带行号的行（给了 range 就只交那几行）和整个文件的版本号。  图片、PDF 与其他二进制文件、目录、设备文件、超过 20 MB 的文件，都算这个文件失败。   / |
| velaros:files.edit | write | 改文件：按行号改几处，或者整份写。**优先整批改**：files 里放几个就改几个，整批一次成败，成了给一个 changeId。  定下改法之后、写进去之前文件被别人改过，整批不写。  路径是管道、设备、套接字，或文件有多个硬链接时不碰。新内容编不成原编码（孤立代理项、GB18030 表示不了的字符）就整批不写。   / |
| velaros:files.undo | write | 撤回一次 edit：那次改的每个文件回到改动前，那次新建的删掉，整次一起。只留最近 50 次改动。   / |
| velaros:images.view | none | 看一批图片（最多 10 张）：图交给你看，返回值里只有尺寸。   / |
| velaros:shell.run | write | 跑一条命令，等它跑完交回全部输出。background 或 interactive 的命令立刻返回，之后用 listTasks 看它跑到哪了；interactive 一定跑在后台，它要开着等用户在控制台里输入。  长驻命令不传 background 也会自动转后台，回执里 backgroundProcess.autoStarted 为真。   / |
| velaros:shell.refreshEnvironment | none | 重新选定本机能用的 shell 并读一遍它的环境变量；Windows 上还会重读用户与系统环境变量写回本进程。  只改本进程的环境，不动用户的 shell 配置文件，也不装任何东西：刷过一次还缺的命令就是没装。   / |
| velaros:shell.listTasks | none | 列出 run 起在后台的任务，最新的在前，每条带着它到现在的全部输出。   / |
| velaros:shell.stop | write | 停掉一条后台任务。普通终止停不下来时抛错，再带 force: true 来一次；任务不存在时抛错。   / |
| velaros:sandbox.create | write | 把一个目录镜像到临时区，脚本先在镜像里跑：落回之前源目录一个字节都没变，镜像随便糟蹋，用完 discard。  回执里的 id 是后面四个操作要的那个；镜像里的命令写不出镜像根，所以脚本里算错的路径在这里只会报错。  gitignore 忽略的目录缺省链接到真实目录（能读，写不进），要在镜像里重新构建就把 ignored 传成 copy。   / |
| velaros:sandbox.run | write | 在镜像里跑一条命令，工作目录钉在镜像根。命令自己失败（非零退出、超时）是正常回执、不抛错，照 success 判。  危险命令（递归删除、丢未提交改动的 git 这类）照常先问用户，用户不点头就抛错、命令不跑。  镜像里连不上网，除非建沙箱时把 network 开了。   / |
| velaros:sandbox.diff | none | 看镜像相对建的时候变了什么：三列相对路径（永远完整），加上新增与修改的文本文件的统一差量；只想看其中几个就传 paths。   / |
| velaros:sandbox.apply | write | 把镜像里的变化落回源目录，回执是真落下去的三列。源目录里要落的文件自建沙箱以来被别人改过，整批不落；  `.git` 里的变化永远不落，要那部分就在源目录重放那几条 git 命令。镜像里什么都没变时三列都是空的。   / |
| velaros:sandbox.discard | write | 删掉镜像，源目录不受影响；沙箱本来就不在时 removed 为 false，不算错。   / |
| velaros:code.query | none | 按一个 intent 问：outline / definition / references / callers / callees / imports / importers / impact / diagnostics。  语言服务没装或这个文件它不认时，结果会降级成按名字找到的候选，`degraded` 里说清楚。   / |
| velaros:code.analyze | none | 要代码图谱后端才答得了的四类：trace（两个符号之间的调用路径）、cycles（依赖环）、deadcode（没用到的代码候选）、routing（框架路由）。  宿主没接图后端时整个调用失败，报 `UNAVAILABLE`——这时改用 query 的 references、impact 凑合看。   / |
| velaros:project.read | none | 读项目里的文本文件：交回带行号的窗口，每个窗口带 fileRef。看图用 `velaros:images`，目录用 list。   / |
| velaros:project.list | none | 列项目里的文件和目录，按深度优先的稳定顺序全部交回；.gitignore 忽略的与版本库内部（.git）不列。   / |
| velaros:project.search | none | 按字面文本或正则搜项目源码，交回全部命中；命中所在的行合成带 fileRef 的窗口，可以直接拿去 edit。   / |
| velaros:project.edit | write | 改项目文件：steps 按顺序合成一个事务提交。   / |
| velaros:project.inspect | none | 看一次改动的差量与状态。   / |
| velaros:project.undo | write | 整次撤销一次改动：写回原文、删掉它新建的文件。   / |
| velaros:computer.screenshot | none | 截主屏：图交给你看（跟在程序结果后面，只看一次），返回值是它的几何与 snapshotId。   / |
| velaros:computer.move | write | 把指针移到一个坐标，不点击（悬停用）。   / |
| velaros:computer.click | write | 在一个坐标点击：按钮、菜单、输入框这类桌面元素。   / |
| velaros:computer.typeText | write | 在当前焦点处原样输入文字；先点一下输入框拿到焦点。组合键用 key。   / |
| velaros:computer.key | write | 按一个键或组合键：Enter、Esc、Tab、快捷键。普通文字用 typeText。   / |
| velaros:memory.list | none | 当前这一份的全部记忆，含正文，按更新时间从新到旧排。   / |
| velaros:memory.save | write | 写一条：id 已有就整条覆盖（tags 不给就沿用原来的），没有就新建。   / |
| velaros:memory.remove | write | 删一条：真删，删了就没了。   / |
| velaros:office.createWord | write | 生成 Word 文档（.docx），或把新内容接在已有文档末尾。   / |
| velaros:office.createPresentation | write | 生成 PowerPoint 演示文稿（.pptx）：给 Markdown 自动排版，或逐页给元素精细控制。   / |
| velaros:office.createSpreadsheet | write | 生成 Excel 工作簿（.xlsx）：给 CSV、Markdown 表格自动成表，或给结构化工作表（多表、公式、样式、合并、冻结）。   / |
| velaros:office.readPdf | none | 按页读文本型 PDF 的可选择文字。   / |
| velaros:office.wordToPdf | write | 把 Word 文档转成 PDF，尽量保留排版（要本机装了 LibreOffice）。   / |
| velaros:office.latexToPdf | write | 把 LaTeX 源码编译成 PDF：论文、数学公式、要求严格排版的文档；普通文档用 createWord 就好。   / |
| velaros:office.editPdf | write | 编辑 PDF 写成新文件：挑页、重排、删页、旋转、贴文字、改文档信息。   / |
| velaros:office.preview | write | 预览 Word、PowerPoint、Excel 文档的结构与正文，检查生成的文档对不对；也可以写出 HTML 或 PNG 预览给人看。   / |
| velaros:office.toMarkdown | write | 用 MarkItDown 把 PDF、Office、HTML、CSV、JSON、EPub 这类文档转成 Markdown 来读（要装了 MarkItDown）。   / |
| velaros:browser.open | write | 打开一个网站并进入它的站点（换网站就再 open 一次，各站点的工作区互不相通）。   / |
| velaros:browser.leave | write | 退出站点：之后要页面的操作都要先 open；站点工作区里的文件留着。   / |
| velaros:browser.state | none | 看现在进没进站点、在哪一页、有哪些标签页、有没有挂着等处理的弹窗下载与权限；没进站点时也能调。   / |
| velaros:browser.show | write | 把受控页面显示出来给用户看，不执行任何脚本。   / |
| velaros:browser.switchTab | write | 把之后的操作切到外部浏览器的另一个标签页（不关闭任何窗口）。   / |
| velaros:browser.inspect | none | 看页面：正文、标题结构、链接、可交互元素与表单字段（元素带 target，可以直接交给 click 这类操作）。   / |
| velaros:browser.screenshot | write | 截图：图交给你看，返回值是落盘位置、坐标换算与标注说明。能在页面里读的（表格、列表、文字）用 evaluate 读，别靠截图。   / |
| velaros:browser.evaluate | write | 在页面里跑一段 JavaScript，交回它的值：结果按 JSON 整份取回（DOM 元素换成它的描述，环引用写成 "[Circular]"，日期照 toJSON），  超过 10000000 个字符抛 BROWSER_RESULT_TOO_LARGE；页面里抛错（语法错误也算）抛 BROWSER_SCRIPT_FAILED，message 带页面的报错与它在 script 里的行列。  读页面、取表格列表正文、改 DOM、设下拉框、读 localStorage 都用它。   / |
| velaros:browser.frames | none | 列出页面的框架树：顶层页面与各层 iframe（含跨源的），id 交给 evaluate、waitForFunction 的 frame。页面跳转之后旧 id 作废。   / |
| velaros:browser.click | write | 点一下元素或视口里的一个点；元素没找到时如实回 matched 为假与原因，只在唯一确定的元素上改用坐标补点。   / |
| velaros:browser.fill | write | 往输入框、文本域或可编辑区域写入文字，替换原来的内容（真实输入）。   / |
| velaros:browser.hover | write | 把鼠标移到元素中心（悬停出菜单、提示）。   / |
| velaros:browser.insertText | write | 在当前焦点处插入文字。   / |
| velaros:browser.press | write | 按一个键或组合键（提交表单按 Enter）。   / |
| velaros:browser.keyDown | write | 按下一个键不放，直到 keyUp。   / |
| velaros:browser.keyUp | write | 抬起一个按着的键。   / |
| velaros:browser.mouseMove | write | 把鼠标移到视口里的一个点（按着鼠标键时就是拖）。   / |
| velaros:browser.mouseDown | write | 在鼠标现在的位置按下一个鼠标键。   / |
| velaros:browser.mouseUp | write | 在鼠标现在的位置松开一个鼠标键。   / |
| velaros:browser.wheel | write | 在鼠标现在的位置滚一下滚轮（地图、虚拟列表、只认滚轮的区域）；整页滚动在 evaluate 里 scrollBy 就行。   / |
| velaros:browser.drag | write | 把一个元素拖到另一个元素上。   / |
| velaros:browser.upload | write | 给 file input 选一个站点工作区里的文件。   / |
| velaros:browser.goto | write | 在当前站点里跳到一个网址（换网站用 open）。   / |
| velaros:browser.back | write | 后退。   / |
| velaros:browser.forward | write | 前进。   / |
| velaros:browser.reload | write | 刷新当前页。   / |
| velaros:browser.waitForFunction | write | 等页面里一个条件成立，交回判定式的值（元素出现、文字出现、地址变了、数据加载完，都写成一个判定式）。   / |
| velaros:browser.waitForLoad | none | 等页面加载到某个状态，交回那时的页面状态。   / |
| velaros:browser.waitForEvent | none | 等一个挂起事件出现，交回这个事件（点了下载按钮之后等下载事件，再 handleDownload）。   / |
| velaros:browser.handleDialog | write | 处理 JS 弹窗（alert、confirm、prompt）。   / |
| velaros:browser.handleDownload | write | 保存或取消一次下载。   / |
| velaros:browser.handlePermission | write | 允许或拒绝一次权限请求。   / |
| velaros:browser.download | write | 带着当前页面的登录态下载一个资源到站点工作区。   / |
| velaros:browser.savePdf | write | 把当前页面导出成 PDF。   / |
| velaros:cdp.send | write | 发一条 CDP 命令，交回协议原样的结果；协议报错抛 BROWSER_PROTOCOL_FAILED，message 是协议给的原话。   / |
| velaros:cdp.events | none | 读这条会话收到的事件（最早的在前）。   / |
| velaros:cdp.waitForEvent | none | 等一条事件到来，交回它（先记下 events 的 last，再触发动作，再从 last 之后等，不会错过）。   / |
| velaros:cdp.reset | write | 断开你的会话：开过的域、设过的仿真与拦截、缓冲的事件一并清掉；下一次 send 重新连一条。   / |
| velaros:devtools.diagnostics | none | 读诊断：先按种类过滤再取最近的几条，网络条目带 requestId。   / |
| velaros:devtools.request | none | 读一次网络请求的请求头、postData、响应头、耗时与体积，可带响应体；较早的请求可能已经读不到。   / |
| velaros:devtools.zoom | write | 调页面缩放。   / |
| velaros:devtools.network | write | 设常驻的网络规则：断网、加请求头、拦请求、给请求回假响应（宿主一直替你应答，程序跑完也生效，再调一次就换掉）。   / |
| velaros:devtools.startTrace | write | 开始录性能 trace；到点自动停时直接交回分析摘要。   / |
| velaros:devtools.stopTrace | write | 停止录 trace，交回 Core Web Vitals 与可深入分析的 insight 清单；原始 trace 落在站点工作区。   / |
| velaros:devtools.insight | none | 对最近一次 trace 的一条 insight 出详细分析。   / |
| velaros:devtools.heapSnapshot | write | 采一份 V8 堆快照落盘（按「基线、操作、回退」各采一份对比着查泄漏）。   / |
| velaros:devtools.startRecording | write | 开始录屏：之后的页面操作都录下来，stopRecording 合成 GIF。   / |
| velaros:devtools.stopRecording | write | 停止录屏并合成 GIF 落进站点工作区（帧数到上限会自动截断，frameLimitReached 为真）。   / |
| velaros:devtools.userScripts | none | 列出全部用户脚本、总开关，以及哪些脚本匹配当前页面。   / |
| velaros:devtools.readUserScript | none | 读一个用户脚本，带源码。   / |
| velaros:devtools.createUserScript | write | 新建一个用户脚本（一律先停用）。   / |
| velaros:devtools.updateUserScript | write | 改一个用户脚本。   / |
| velaros:devtools.enableUserScript | write | 启用或停用一个用户脚本。   / |
| velaros:devtools.enableUserScripts | write | 打开或关闭用户脚本的总开关。   / |
| velaros:devtools.moveUserScript | write | 调整一个用户脚本的注入顺序。   / |
| velaros:devtools.deleteUserScript | write | 删掉一个用户脚本（不撤销当前页面已经执行的副作用）。   / |

## 集成修复

重启同一目标保留步骤、上一视图和用量；旧记录缺省 step=0，旧视图缺少 progress 时重建。补齐 Context 发布元数据和 package catalog。全领域回归发现 CDP 模板需要 btoa/TextEncoder，已在既有 QuickJS 堆内补齐数据编码，并验证 Unicode、二进制往返与字符边界。

## 验收依据

详见 platform-validation.md。测试中的 off 配置专门覆盖传统工作集兼容行为；正式缺省路径另有 active 集成测试。未更改其他产品仓库。
