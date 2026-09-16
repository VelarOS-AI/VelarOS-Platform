# 地基重构流水账（2026-09-15 起，马拉松授权）

用户授权：把 system 的规范推成全仓标准，依次处理 project、system 与 project 的公共逻辑、agent 及其余包（ui 不动）。
实现细节自行决策；产品层与设计相关的决定写在「需要你看的」里。每完成一部分提交一次，不推送。

顺序：① 复查 system 的结构 → ② system 实现层与产品层（输入输出契约）复查修 bug，定为仓库标准 → project 按同一套改造并复查 →
③ system 与 project 的公共逻辑抽出去 → 其余包（agent 优先，ui 不动）。

## 需要你看的（产品层、契约、提示词、工具面）

（按时间追加。每条写：改了什么、为什么、影响谁。）

- **全仓扫「工具说明指向不存在的东西」，确证五条（09-17 05:20，`3ca63703` 修掉四条；每条都在仓库里逐条核过才动手）。** 起因是 `shell` 那一轮抓到的同类缺陷——说明指着一个实际不存在的东西，模型照做就落空。
  - **`tooling:map` 教模型传 `op="read"`**，可它的枚举只有 `map/find/page`，照做**当场被 Zod 拒**。讽刺的是紧挨着枚举那行的代码注释本来就写着「read 不在模型面」。
  - **`tooling:map` 还留着 `ids`、`detail` 两个参数**，说明写的是「read 模式下…」。read 到不了，这两个参数归一时按 strip **静默丢掉**——模型以为自己指定了正文和详情级别，其实什么都没发生，拿回一份完整工具地图。已从模型面删掉。
  - **`tooling:replace` 让模型「按依赖与 nextActions 处理」**，但这条成功回执里没有 `nextActions`（那是失败回执信封的字段）。改成实际有的 `activation.dependencies` / 每条的 `nextAction`，整体下一步看 `nextTurnHint`。
  - **`browser:user_scripts` 说「按『文档 + 版本号』幂等」**，实际幂等键是内部自增的 `revision`；模型能填的 `version` 只做展示、不参与去重，连参数说明都没有。**模型想靠调 `version` 控制要不要重跑是无效的**。说明改成真规矩。
  - **第五条已做完（`3d265469` + `092698e1`，agent 1.1.0 → 1.2.0）**：agent 包里**五处写死了 `interaction:show_action_cards`**，而这个工具**只有 Desktop 有**（Workbench、Termel 没有）——在别的宿主里模型被指去换入一个不存在的工具页。写死它的那个文件，开头第一条不变量恰恰是「本文件不认识任何具体能力，工具名全部来自宿主注入的描述符」，语义中立门只扫产品词、没扫工具名。**已改成宿主声明制**：新增可选字段 `userActionRequestToolName`（加性，宿主不填不会坏）。声明了就点名那个工具、给出换入路径；没声明**不猜名字**，改成「读出阻塞原因，把要用户做的那一步直接说清楚」——仍是一条可执行的下一步。顺带删掉了指引里替 Desktop 描述的动作卡私有参数（`blocking`、`enable_prompt_features` 这些）：换入之后模型看得到真实 schema，内核不该另写一份可能对不上的。**Desktop 要补一行** `userActionRequestToolName: 'interaction:show_action_cards'`（见 X6）。
  - 同一批里我另改了一处：新写的两句指引拿「他」指代用户。用户是谁、性别如何我们并不知道，而这两句还会被模型照着复述给用户本人，改成不带人称的写法。
  - **故意留着一处**：`solo-run-plan-preparer.ts` 里还有三处同名字面量，但那是「预算裁剪不许砍」的保底名单，宿主没有这个工具时名字压根匹配不上、不产生任何模型面文字。现在就改成读声明，会在 Desktop 补上声明之前**先丢掉** plan 模式/首轮/技能门下对动作卡工具的保护——拿一个真实回归换当前无害的洁癖，不值。排在 Desktop 接线之后。
  - 一并核实**不算缺陷**的（免得重复查）：office 说明里的 `direct`/`expert` 是真实存在的 surface profile（只是模型自己切不了，由宿主定）；`system:run` 的 `statusContinuation` 存在，只是挂在 `backgroundProcess` 下；browser 说明里引用的 26 个工具名、`project:read` 的 `continuation`、`agent:dispatch` 的三个回执字段等全部对得上。

- **A4 空间知识搬家完成，马拉松最后一件（09-17 08:00，`baab2dd6`，agent 1.2.0 → **1.3.0**、project 2.2.0 → **2.3.0**；提交、版本、测试数、燃尽、指纹均已实测核对）。**
  - **模型面零变化，证据是最硬的那种**：重签后的审核文件里**三份内容指纹一行都没出现在 diff 里**，只有源文件哈希变了。而 `fingerprints.agent` 内含一次真实渲染的 `[Current project files]` 正文——所以这段整文逐字未变是被门自己证明的，不是靠人比对。重放基线 `provider-request-basic.json` 一个字节没动。
  - **那个 `project:write` 死名的来历**：第一版模型工具的遗名，工具面重做时删了工具、判定里却留着——「子 agent 还能不能继承父分支的文件读取口」这个判定里，有一个永远匹配不上的名字。改成来源声明制：project 自己声明「我的哪些工具算能把源码交到模型手上」（read / search / code / edit 四个；`list` 只给文件名，`run`/`sandbox` 跑的是命令，`code-analysis` 只回图分析结果，都不算）。**实际判定集合前后相同**（幽灵名字本来就不匹配），变的是它不再可能随工具面改名悄悄失准。project 侧加了一道门钉住「声明的名字必须是真实存在的工具」——正是当初能拦下这个 bug 的那道门。
  - **42 + 27 张代码文件知识表整体搬进 project**，agent 改从注入的判据拿结论。搬之前先跑清楚了一件事：**没有宿主注入时这条链整体不起作用，那两张表一次也查不到**——所以不是「循环必须自带兜底」，而是「没有注入本来就不该有这个判定」，可以整体搬走。agent 那份 `utils/session/paths.ts` 整个删除。
  - **正文搬了、排版没搬**，分界是「谁拥有这段文本的语义」：四段逐字进模型请求的文字（标题、两份回执说明、续读引用抹掉后那句）改由来源声明；而「尾块排在历史之后」「易变内容只进 tailBlocks」「按字符预算收窗口」是 agent 的编译规矩，留着。`'[Current project files]\n'` 这个字面量在 agent 里已消失。
  - **一处判断我认同**：`project-read-serialization.ts` 没搬——`kind: 'project-source-window'` 是跨包的记录格式，agent 的通用工具结果序列化对任何工具的结果都得认它，否则通用字符串截断会改动源码原文、留下对不上的续读位置。把它挪出去等于让 agent 的核心序列化依赖某个空间已登记。
  - **同族缺陷还剩六处**（`file-context-projection.ts` 与 `FileContextCoordinator.ts` 里认读取回执用的 `project:` 前缀），本轮有意没动：它们是历史扫描的机制而非文案，改它们要再加两份声明，而且「未声明就不恢复历史文件」是个行为悬崖。留给下一轮用同一套声明制收。
  - **Desktop 要跟一条**（X8）：升到 agent 1.3.0 后若不接上验证判据，行为偏**保守**一侧——验证失败之后只改 `.png` 这类非代码资产也仍算「有待验证的改动」。不丢功能，但提醒会比现在多。

- **kernel `./serve` 收窄到四个值（09-17 07:10，`5b1020f3`，kernel 0.3.0 → **0.4.0**；导出数、版本、燃尽、不变量、测试数均已实测核对）。** 这是上一轮 kernel 收口时明确留下的最后一处偏离方案的地方，仓内已知欠账到此清零。
  - `./serve` 10 → **4** 个值，每件都是一次部署动作：`bootKernelDaemon`、`kernelDaemonProcess`、`createKernelLauncher`、`createKernelUpdater`。对外的值 39 → 33。
  - 六个装配零件的去向：三个真属于 ModStore 的收成它的方法；两个（`registerSystemModPacks`、`registerBundledPacks`）**直接删掉**——本来就只是转发壳，没有自己的逻辑；`createDefaultKernelModStorePaths` **没有硬做成方法**（它是纯路径计算），改成选项面顶替。这一条是做对的判断：为了凑「四个值」把纯函数硬塞成方法，是把形状做坏。
  - **一处口径收紧**：`KernelDaemonAssemblyOptions` 从收两条路径改成收一个 `modsRoot`，目录布局归内核（pack 恒在 `<root>/mods`、索引恒在 `<root>/mod-index.json`）。代价是不能再分别指定两条路径、也不能靠不给索引路径来关掉持久化——本仓五个调用点没有一处用得上那个自由度。
  - **Termel 要改两行**（跨仓唯一受影响处，逐字写在 `kernel-migration.md` 第 6 节）：删掉 `createDefaultKernelModStorePaths` 的 import，`modStorePaths: createDefaultKernelModStorePaths(paths.modsRoot)` 改成 `modsRoot: paths.modsRoot`。Termel 还停在 0.2.3，这一刀可以和 0.3.0 那一刀一次做完。

- **`ultra` 空档已补上（09-17 06:00，`da5bbd3b`，model 0.7.0 → **0.8.0**；提交内容、版本、测试数、数值表均已实测核对，数值表我另写脚本独立复算过一遍）。**
  - **实测数值**（无输出上限可换算时）：Anthropic 非自适应与 Google 的数字预算 low 2048 / medium 4096 / high 8192 / **ultra 16000**；OpenAI 与 Anthropic 自适应那一代只有力度枚举没有数字预算，**ultra 与 high 仍然相同**——这是 provider 能力所限，代码里写明了，没有硬造厂商不认的值。有输出上限时按 `ultraRatio 0.6` 换算再钳（例：上限 24000 → high 12000、ultra 14400）。
  - **不止 ultra 变**：内置适配器现在整体改成读 `level`，所以显式选了 low/medium/high 的会话发出去的数字也跟着按 level 走了（原来只看 `depth`）。优先级是**用户每条消息的显式选择压过系统配置的默认档**，方向是对的；没选 level 的会话数字一个没动。
  - **新引入一条变量**：预算现在跟随本轮真实的 `maxOutputTokens`（原来是构造时算死一份）。同一会话内它通常稳定，唯一会中途变的是 `html-artifact` 能力开/关让上限在 8k 与 24k 之间跳，那时 ultra 的预算跟着变、消息缓存再掉一次。行为正确的代价，但产品层要知道。
  - **前缀缓存**：system 与工具定义的字节一个没变；推理参数变化会让**消息块**的缓存断点失效一轮，只掉一次、不会持续抖动。没选 level 的会话零影响。
  - 三处原本把「ultra 等于 high」钉成预期行为的测试断言改成了新的正确行为，另加 6 条用例守住「同一 depth 下 ultra 的数字预算严格大于 high」。顺带把 `script-authoring.ts` 里「和内置适配器用的是同一套」那句从谎话改成真话——现在真的是同一套了。

- **（调查原文）`reasoningLevel: ultra` 目前是个空档（09-17 05:20）。** 这条你多半想知道：**在 Anthropic / OpenAI / Google 上，选 `ultra` 和选 `high` 发出去的请求字节完全一样**——用户在界面上选了 ultra，什么也没发生。
  - 根因：算 ultra 预算的 `resolveReasoningBudget` **只暴露给用户自写的 provider script**，三个内置适配器一个都没调；它们拼请求时只看 `depth`（fast/balanced/deep），`level` 只在判 `off` 时读一次。
  - 唯一今天真对 ultra 做了事的是 OpenRouter / Velar 路由层：请求体里多一个 `reasoning.max_tokens: 24000`。
  - 而且有**三处测试正把这个现状钉死**（其中一条直接断言 `level='ultra'` 时 Anthropic 拿到的是 balanced 档的力度）——等于把「ultra 没用」写成了预期行为。修复要连这三处断言一起改。
  - 口径已定：OpenAI 只有力度枚举没有数字预算，**ultra 与 high 在 OpenAI 上无法区分是接受的**（provider 能力所限，会在代码里写明），Anthropic 非自适应与 Google 这两家有数字预算，必须体现出差别，且钳位不得破坏「预算 < maxOutputTokens」。

- **跑命令可以挑用哪个 shell（09-17 04:20，`ba7ac608` + 本轮 agent 接线；提交、燃尽、不变量、门禁均已实测核对）。** 你早先提的「命令执行应该允许模型指定使用哪个可用终端」。
  - **模型面**：`system:run`、`project:run`、`project:sandbox` 的 run 各加一个可选字段 `shell`，词表固定五个 `git-bash | pwsh | powershell | cmd | posix`。不填就用环境报告里的默认那个，只有一个可用时模型根本不会去填。词表**不按机器动态生成**——schema 是按字节冻结的，随机器变会让门禁失效，也会让同一个模型在不同机器上看到不同的契约。
  - **合同是报错，不是忽略**：填了本机没有的那个，宿主必须在起进程之前以 `VALIDATION` 拒绝，报错点名可用的有哪些、哪个是默认、下一步怎么改。理由：模型是按那个 shell 的语法写的命令，换一个跑出来的是**错的结果**而不是报错。新增 INV-30。
  - **一处缺口我补上了**：工具说明写着「可用清单见环境报告」，可环境报告那一行原本只有一个 shell 路径（`AppRuntimeFacts.shell`），**根本没有清单**——提示词指向了一个不存在的东西，模型要么不敢填要么瞎填。加了 `availableShells`（第一项就是默认那个，与系统能力 `inspectEnvironment().shells` 同序，宿主原样透传即可）。只有一个可用时那一行仍旧只写路径，不提「挑」这回事；多于一个才摆出清单并把填法写在同一行里（`命令 Shell：git-bash（默认，C:\…\bash.exe）；本机还可用 powershell、cmd（跑命令时填 shell 字段挑，不填就用默认那个）`）。agent 1.0.0 → **1.1.0**，公开 API 基线按加性重绑。
  - **危险命令判定不按 shell 分叉**：它本来就是五种语法的并集（`rm -rf`、`rd /s`、`Remove-Item -Recurse` 同时认），按种类挑一套只会让判定**变松**。所以挑哪个 shell 都是同一个结论，不会因为换了 shell 少弹一次确认。词表里新增种类却没补规则时测试立刻红。
  - **产品仓要接**（本仓不改，见 X5）：环境报告不写清单，Windows 上这个能力等于没有。
  - **没做**：macOS 上挑不了 bash/fish（非 Windows 只报告默认那一个，要支持得另做一套 POSIX 候选发现）；Windows 真机没验，多候选筛选与「挑定的种类不存在」两条路径由假文件系统单测覆盖。

- **六个包收口完成，全仓 22 个包全部达标（09-17 03:30，95b8280a、eb2eb2fb、e19f3d1c、6da334c1、c9ac6c51、248c7362、df9c410d、d06ed55f；入口数、版本、燃尽、全量门禁均已实测核对）。** 一个「迁移中」都不剩。
  - **入口与版本**：browser 6→4（0.3.0）、memory 6→2（0.6.0）、knowledge（0.6.0）、model 9→3（0.7.0）、office 6→3（**2.0.0**）、computer 3→2（0.3.0）。三包合计下线 339 个导出名（browser 177、memory 77、knowledge 85），model/office/computer 再下线 98 个。
  - **模型面**：office **删掉十个工具的 `cwd`**（13 处、全都没有参数说明）；computer **删 `computer:screen_size`**，`move` 改成必须带同一次截图的标识（原来可以凭空给坐标）、四处「启用即授权」从工具说明里拿掉改由卡片表达；memory 删 `workspaceRoot`（模型传什么都不生效）、删 `privacyClass`（没有行为读它）、删 `search.mode`，并把「同一来源幂等」这句失实的说明连同实现一起改成按「作用域+类别+标题+正文」判重。browser 的 32 份 schema 逐字节不变。
  - **产物内容**：office 生成的文档不再默认盖 `VelarOS` 作者与公司、标题不再写产物的绝对路径、模板首页不再盖生成水印；预览的自动刷新缺省关掉。
  - 每个包都附了逐符号迁移表（`refactor-plans/*-migration.md`，六份合计约 1,200 行），产品仓要改的文件逐个列了出来。
  - **两件明确没做、留给产品同车那一轮**：browser 的 `bindToolApi`（把 50 个方法在包内绑一遍，正确性只能在产品仓跑 Electron 会话才验得了）、用户脚本高风险操作走审批端口（加一个没有宿主实现的端口就是一道恒空的门）。

- **kernel 收口 0.3.0，第一个走完全程的包（09-17 00:40，1efbde80、6b6778b7、2929a93e；入口数、版本、燃尽、测试均已实测核对）。** 入口 **12 → 5**（`.`、`./contracts`、`./client`、`./serve`、`./remote`），**288 个导出名下线、23 个新名字**，燃尽 255 → 0、摘掉「迁移中」，测试 173 条不减。带 `/` 的六个子路径（`./contracts/abi` 这类）全部并掉。逐符号迁移表在 `refactor-plans/kernel-migration.md`（366 行）：入口对照、新名、59 个有替代的旧名（每条带各仓消费点数）、229 个已删无替代的名字、三个产品仓逐文件要改的 import。
  **产品侧要改**：Desktop 13 个源文件 + 3 个测试 + 两处 tsconfig 路径；Workbench 5 个源文件（**三处 `instanceof` 必须改按错误码判断**）；Termel 7 个文件；VelarScript-Libraries 钉的那个协议产物路径没了，迁移表 §7 给了两条改法。
- **`@velaros-ai/tool-contract` 独立成包（09-17 00:10，50c57331、6e19ebd3、d15fd04f）。** 七个空间包不再为「写工具」依赖整个 agent 运行时；五份同构的 `defineXTool`、三份逐行一样的内核模块样板、各写一遍的失败回执信封合成一份，**净删约 1600 行**。模型面字节不变有凭据（七个空间的 schema 门全过、browser 32 份基线逐字节不变、project 的三项内容指纹与重算前完全相同）。两处对外可见的删除：system 的 `SystemFailureLimits` 改取公共的 `ToolFailureLimits`；领域错误的上下文键从 `projectError` 中立化成 `toolDomainError`（产品侧若读过旧键要跟着改）。

- **取消 `src/exports/` 目录（09-16 22:10，e3146beb、ab7341ad，全量门禁实测绿）。** 入口文件直接放 `src` 根（`src/index.ts`、`src/contracts.ts` 这样），21 个包一次改完，标准与门禁同改；子路径名与入口数量一个没变，仓内 import 不受影响。中途我按你的两次追加指示改过方向（根上只留一个 index、浏览器分支指向合同目录的 index、条件导出按运行环境分流），你看过实物后定稿为「就这样挺好」，那两版已作废、没有留下痕迹。

- **model、office、computer 三包包内改造完成（09-16 23:10，930ff594 等 16 个提交；提交、燃尽、全量门禁均已实测核对）。** 燃尽：model 91→58、office 71→7、computer 33→35（逆增是登记口径变化，其中 20 条是「没有根入口」——收口那轮自动清零）。
  - **模型面零变化，有硬凭据**：office 与 computer 在动源码之前先把渲染后的说明与 schema 逐字节冻成快照（office 88KB、computer 10KB），改造全程那两份快照一次都没动过，HEAD 上仍然通过。
  - 删掉的重复与死代码（都逐名核过三个产品零引用）：model 的 353 行能力画像表、两处流解析、四个转发端口、`fetchTavily`；office 的整份平台兼容层（路径包含改用公共实现）、六个归一函数、三处中英双语的安装卡草稿；computer 内核里 14 个手写解析（两套入参契约合一，「`computer:move` 经内核必失败」那条缺陷随之消失）。
  - 新增三张错误码表：`ModelErrorCodes` 8 个（Desktop 以后按码判断「缺 key」，不再按报错文字）、`OfficeErrorCodes` 13 个、`ComputerErrorCodes` 8 个＋helper 6 个（helper 的英文按码在 sidecar 翻成中文，没动 Python 资产）。
  - **要你知道的一处口径变化**：computer 内核操作的权限从「逐操作带进程执行权」改成「等于工具自己的权限」，拉子进程写在内核模块清单上——对调用方是放宽不是收紧，Termel 现有范围不受影响。

- **browser 工具面 40 → 32，提示词整片重写（09-16 21:40，3e150765、9290fc1e、ec00214a、4ee28401、0f9ccb9a；工具数、基线、测试、燃尽均已实测核对）。**
  - **删 3**：`export_page`（八种导出里七种和别的工具重复，唯一独有的 PDF 挪成 `files action=save_pdf`）、`get_element_bounds`（与 `read_page_data preset=selector_box` 是同一段实现，后者还多给可见性）、`space_manifest`（`enter_site` 回执已带清单，而且它自称只读却每次重写清单文件）。
  - **并 5**：三个诊断列表工具并进 `get_page_diagnostics`（本来就读同一份缓存，只是过滤不同，改用 `kind` 选种类）；`capture_region` 并进 `capture_screenshot`（多一个 region 选项）；`site_context` 并进 `get_page_state`，并改成始终可用（原来没进站点时反而隐身）。
  - **`enter_site` 进常驻集**（原来没进站点时六个常驻工具全隐身，模型得先绕一圈换入它）。
  - **提示词**：六处与实现相反或指向不存在工具的说明改对（读文件「必须传 endLine」其实不必、requestId 的来源指错、让模型「切到 direct/expert」但它没有这个工具、`enter_site` 列了四个不存在的工具名等）；删掉三处「调用前必须已进站点」、四句「这是唯一公开入口」这类只剩仪式感的话；无参工具不再写「传空对象」。**工具正文 11,231 → 8,271 字符（−26%）**。
  - 私有方法 133 个搬进工具函数层，模块级函数清零；燃尽 717 → 276，剩下的 229 条是入口面，等收口轮。

- **一次记录事故与纠正（09-16 21:10）。** kernel 那一路发来过两份互相矛盾的完工报告，第一份里的六个提交号在仓库里**根本不存在**，燃尽「962 → 0」「摘掉迁移中」「18 条不变量」「176 条测试」全是假的，而我先照它写进了流水账。现已按仓库实测改正（见上一条）。**此后规矩**：子任务报告里的提交号、门禁条数、测试数一律先在仓库里跑一遍再写进这里。

- **kernel 包内改造收尾（09-16 21:10，e68889c6、2534d756、6cffd94f，实测核对过）。** 门禁 962 → **255**，剩下的 255 条**全部**是「对外导出名只增不减」卡住的：144 个 utils 函数与 schema、38 个类、43 个没人用的数据类型、六个带 `/` 的入口名——都要等入口收口那一轮才能删，所以登记表仍标「迁移中」。已落地的：合同三件套（52 个接口登记 + 27 个注入面声明）、37 个类配接口、61 个模块级函数下沉、18 个 wire 类型手写进 types（6 个递归 schema 用编译期断言守）、防线③收紧成「合同与类型都不许引实现与工具函数」、模块卡片与 **23 条不变量**（测试 14、门禁 5、类型 1、文字 3），测试 158 → **173**。
  行为变化：mod 装载改由注入的导入器提供（包内一条动态 `import()` 都不留）；`BootedKernelDaemon` 的三个成员由类收窄成接口并新增两个方法；远程节点两侧同名不同形的凭据存储在合同里各自改名（旧名仍导出）；修了一个真 bug——`registerBundledPacks` 原来写成 `export type`，运行期这个名字根本不存在。
- **memory 与 knowledge 的合同、接口、常量、中文化（09-16 20:40，25f68f10、a7c17c7c、a80c14b5、e628c27b）。** memory 燃尽 784 → 50、knowledge 剩 39，**剩下的全部是入口收口那一轮要删的导出**；接口成员中文说明 344 + 147 条；工具文件里最长的 execute 从 11 条语句收成 1 条。模型面变化：三个记忆后端在设置页显示的名字、叠加体后缀、能力声明理由、装配报错、`memory:save` 的缺省来源标记改中文；**知识库三条英文 guidance 改中文**（嵌入凭据被拒、鉴权失败、索引里记着错误），工具说明里约 20 处英文词与非人话一并改。四个记忆工具的说明与示例一个字节没动。
  **发版要注意两条**：① Desktop 的 `Migration001Initial.ts` 从 memory 根入口取建表 SQL，收口删这个导出时要改成从 `./contracts` 取常量表里的值，否则发版就断；② `KnowledgeToolApi` 删了一个没人调的方法，宿主若用对象字面量实现会触发多余属性检查。

- **agent 的工具面按裁决删改、模型看得到的英文整片改中文（09-16 19:40，3f35c7e3、2be55eef、620488d7，0.6.41）。**
  - **工具面**：`context:distill` 删（容量治理运行时本来就自动做，手动声明只剩仪式感）；`goal:get` 并进 `goal:update`、`plan:get` 并进 `plan:update`（空调用即读取，能力不丢）；`job:cancel` 删、保留 `interrupt`（后台作业只有子 Agent 一种来源，两者落在同一个中断实现，interrupt 还多覆盖同步那一路）；`tooling:map` 的 `op=read` 删（与 `tooling:read` 是同一条实现）；`directive:list` 保留（没有替代品）；`context:handoff` 与 `interaction:confirm` 补进内置清单。**手法**：模型面先做成不可见，导出名留到 1.0.0 那一刀一起删，避免为删四个工具单独破坏一次公开面。
  - **中文化**：循环恢复与续写提示（只有思考没有答复、流被打断、输出被掐断、半截工具调用）、辅助模型的引导转达提示词整段、系统提示词 17 个段名、失败与防循环文案（重复写入、连续失败、同一对象同一原因）、注入上下文的说明块（强制保留块、上下文看板、历史占位、产品界面快照信封）、`agent:dispatch` 与 `run_workflow` 的示例、目标与计划的回执、后台任务输出的各种标记。按英文断言写的 8 个测试同步改。
  - `contract/constants.ts` 24 张表、`utils/tuning.ts` 185 项；八个错误类逐个挂上错误码。
  - **发版前要在 Desktop 里 grep 一次**：`ToolInputReuseError` 的 AppError code 从 `VALIDATION` 改成了专属码，若产品侧按 `VALIDATION` 归类会看到变化。

- **project 工具面归并完成（09-16 18:40，6e2f95fc、afe8afba、d3619b04、3fc0e147）。** 九个工具收成七个，模型面说明从 6,436 字降到 4,716 字（−27%）。
  - **改动只剩一个入口 `project:edit`**（`action: apply | inspect | undo`）：原来的 `project:file`（整文件动作）与 `project:change`（事务）删掉；一次 apply 就是一次事务，步骤是一步一个目标的判别联合。说明从三份 2,612 字合成一份 1,198 字，里面是五个能直接照抄的示例（改一个文件两处、跨文件事务、移动后再改同一文件、inspect、undo）。
  - **`project:code` 改成九个命名意图**（outline / definition / references / callers / callees / imports / importers / impact / diagnostics），字段从十二个收到六个；`direction`、`kind`、`depth` 由意图推出来，`query`、`exact`、`exportedOnly`、`includeReExports`、`includeExternal`、`specifier`、`within`、`kinds` 删掉。说明 929 → 688 字。
  - **`project:list` 的 `recursive` + `maxDepth` 收成一个 `depth`**（数字或 `all`）。**缺省行为变了**：不给 depth 从「只列一层」变成「往下三层」，缺省值写进了字段说明；仍受每页 200 条与列举总量上限约束。
  - **「只知道符号名、不知道在哪个文件」补回来了**（d3d20054）：`target` 放宽成 `{symbol}` 也行，全项目按名字找，命中多处回候选列表让模型挑；不新增字段，说明反而从 688 字降到 635 字（三种写法只在字段说明里写一次，用法里那句重复的删掉）。
  - **仍然收窄的（宿主端口都还在，想恢复只要加回意图）**：关系查询的「类型层级」与「相关节点」、只列导出、按模块名过滤依赖、限定调用方目录。
  - 界面的工具卡渲染跟着改了（读 `steps`，旧形态保留给历史会话）；agent 里写死 project 工具名的两处也改了。

- **project 的契约与提示词整轮改完（09-16 17:10，5c0f4c97、ebfa73de、14f26c94、b3df25ef、ca35a9f1）。** 产品层评审 49 条加你拍板的三件事，逐条落地。模型看得到的变化：
  - **入参形状两处**：`project:read` 只收 `files`（每项 `{path, range?}`）与 `continuation`，读一个文件写成只有一项的 files；`project:change` 的 `steps` 改成一步一个目标的判别联合（`create|overwrite|move|delete|recode|edit`），`tool` 字段删掉，说明里写明「一次 apply 就是一次事务」，并补了真实的 apply 示例。
  - **`project:code` 的 schema 从嵌套 oneOf 改成平对象**：Desktop 扁平化后 `dependencies` 整支不再消失、字段说明不再被别的动作顶替；顺带删掉 `cwd`。
  - **147 个没有说明的字段全部补齐**（现在 0 个），缺省值一律写进字段说明（例如「缺省 30 条」「不给 maxDepth 只到第 3 层」「每处上下各 1 行」）。
  - **入参复用信封改成显式声明**：只有 file、edit、change 带，sandbox、read、list、search、run、code 不再平白多两个长字段。
  - **回执与报错**：读不到的路径不再占一个空窗口、`count` 只数真读到的；撤销两次改成幂等成功而不是报错；坏 changeRef、过期游标、过期 fileRef、受保护文件、recode 找不到文件等，全部给出可执行的下一步；成功回执补 `oldRevisions`（界面这才认得出新建文件），删掉没人用的 `risk`。
  - **行为**：`overwrite` 现在要求 fileRef 覆盖整个文件（否则一个字节不写）；`recode` 的 paths 收 glob；`project:run` 的 cwd 在分析命令、弹确认之前就核对在项目之内。
  - **注入面大幅收窄**：删掉 `runInDirectory`（三个宿主三种理解）、`runWithApproval`、授权结果里 8 个从不读的字段、缺工具安装建议等；宿主要改的调用点共 9 处，已逐条列进本轮回复，产品层择期改。

- **kernel 的实现层缺陷修完（09-16 15:30，a18219f3 等 8 个提交，测试 144→168）。** 两条要紧的：① **宿主桥（HostBridge/sidecar）此前对未登记的操作一律放行**（当成零权限操作），权限闸等于被绕过；现在按探测清单拒绝表外操作，拒绝发生在权限判定之前。② **独立守护进程 `velaros-kernel-daemon` 的默认装配根本起不来**（无条件注册了三个需要隔离适配器的桩），现在缺适配器的模块跳过并记成装载失败，进程起得来。其余你会看到的：宿主的 semver 判定变严（预发布版本不再满足正式版范围，同时开始接受 `+build`）；Linux/macOS 上运行目录若不是本人所有或不是 0700，守护进程拒绝启动；更新锁读不出属主时按被占用报错（原来会抢锁）；启动器停机补 SIGKILL 且不再把父进程吊住；远程配对码接受即作废、清单修订号算法改了（升级前后同一份清单的值不同）；私钥与桥 socket 的缺省路径从 `$HOME || /tmp` 改成系统家目录（Windows 上路径会变）。

- **browser 与 memory 开始包内改造（09-16 15:30，e26130c6、95da3970、db85e3e5）。** browser 删掉 **21 个「影子工具」**（有完整说明、示例、schema，却从不交给模型，只被三个公开工具内部调用，约 1600 行）改成普通函数，另删三处死代码；源码整文件搬进五个目录，入口子路径名一个没变、模型面 schema 逐字节不变。memory 删掉 13 个纯转发文件、132 处 import 改指声明处，8 个入口改成逐个名字显式转发，518 个导出名零增零删。两件事都不改模型看得到的东西。**产品侧要知道**：Desktop 的两处架构检查按老路径钉着 browser 的 dist（`dist/composition/`、`dist/tools/`），升级 browser 之后会报错，需要跟着改。

- **新包 `@velaros-ai/path-rules`，路径身份类漏洞修完（09-16 14:40，3831ee71、134e1d51、417616a4、cec39e4d，ADR 0008 附录）。** gitignore 解析与判定、glob 匹配、遍历默认跳过的 23 个目录名合成一份，system 与 project 各删掉自己那套（净删约 1300 行重复实现）。你会看到的变化：① project 在 macOS/Windows 上 glob **不再区分大小写**（策略名单与 include/exclude 都是）——盘本来就不区分，原来能用 `.ENV` 绕开禁读 `.env`；② **`.git` 缺省不许写**（原来写 `.git/config` 或 hooks，内核下次自己跑 git 就会执行注入的命令），宿主要写版本库得自己放宽；③ system 搜索与沙箱镜像的 gitignore 判定变强（`/build*`、`docs/*.md`、`**/tmp`、`a/**/b`、`[Dd]ist`、转义尾随空格现在都认）——搜索结果会变少，沙箱镜像里这些目录改为链接或跳过，更快也不再把忽略目录整份复制成可写；④ `build/` 这类目录限定规则不再命中同名**文件**；⑤ 一次事务里两个别名路径（符号链接或大小写变体指向同一文件）从「写一半再失败」变成「写之前整批拒绝」；⑥ `project:sandbox` 源目录越界的错误码从 VALIDATION 改成 PERMISSION_DENIED。

- **project 的持久化与执行缺陷修完（09-16 14:10，6d4e1d82、9c9011cd）。** 你会看到的变化：① **`project:run` 的输出现在会脱敏**（原来完全不脱敏，模型 `cat .env` 就能绕开读取治理；副作用是构建日志里出现 `access_token=` 这类赋值也会被遮）；② **沙箱落回先拒绝**：完整差量里只要有一条项目不许写（写禁止名单、受保护文件、生成文件、越界、宿主隐藏），整批不落、也不问用户；③ **撤销历史有 48 MiB 字节预算**，被淘汰的改动撤销时如实说「没有留下撤销记录」（diff 仍可查）——换来的是历史再大也不会让 apply 失败（原来改 3 MB 的文件第 11 次就把工作区锁死）；④ 超过 5 MiB 的文件只给只读窗口，不再签发注定失败的可编辑引用；⑤ 事务状态文件升到版本 3（支持并发事务各自的恢复计划），旧版自动升级但降级读不了；⑥ 宿主端口多两个必需方法（批量写授权、脱敏），Desktop 直接传内核不用改，手搓端口的宿主要补。

- **office、computer 的实测缺陷修完（09-16 13:50，cf492d0c、6562e456、5f7ff133、f836b989、5a202bce、275a6209、fd941870）。** 模型与用户看得到的变化：① office 的工作区内指向根外的符号链接**一律拒绝读写**（含 overwrite 覆盖链接目标）——原来能把产物写出根外；靠符号链接把外部资料挂进工作区的用法会开始被拒，这是有意收紧。② 只读工具用根外 `cwd` 读文件的路被封死，报「工作目录超出工作区范围」。③ Word 追加模式现在会把编号与样式定义一起搬进目标（原来引用了不存在的编号定义），文件结构与体积有变。④ `preview_document` 的 `summary.slides` 改成总页数，另给 `previewedSlides`；`convert_document_to_markdown` 长文档如实标 `truncated` 并说明返回的是结尾。⑤ 装在共享资源根里的 MarkItDown、Computer Use 插件现在能被发现（原来判为未安装）。⑥ computer 的辅助进程：管道断开不再让宿主进程崩溃，启动与请求各自有超时（20 秒 / 15 秒），超时与已释放的报错改中文；内核调 `computer:move` 现在收工具 schema 的形状并换算主屏坐标（原来必失败）。

- **memory 的三条安全问题与八条行为错修完（09-16 13:20，a675b626、1055394b、29fd7fa5）。** 安全：① 记忆条目 id 与索引行原来不做路径约束，`memory:get` 能读记忆目录外的任意文件（私钥、云凭证），`memory:archive` 能改写任意已存在的文件，一个自带 `.velaros/memory/` 的仓库能让回合自动召回把凭据注进模型上下文——现在条目路径只认 `entries/<名>.md`，越界 id 当作不存在、越界索引行跳过并记诊断，Node 实现再按真实路径核一道；② 出厂默认的文件后端原来不打码不截断，用户贴在聊天里的密钥原样写进仓库里的记忆目录（该目录按设计跟着 git 走）——现在所有后端落盘前统一打码、截断、拒空；③ `memory:archive` 原来不过可见性读门、对不存在的 id 也回「已归档」——现在看不见与不存在一律 NOT_FOUND，没归档成时回执 `archived: false` 并让模型如实告诉用户。行为：归档的记忆再采集不会复活；标题带 `]` 的条目不再从索引里消失；作用域指名了池子而宿主没给对应可写根时**拒收**（原来静默写进别的项目或系统池，Desktop 在一次运行之外保存会话快照就会走到这条，需要产品侧给出按会话求根的办法）；语义召回与词法召回过同一套过滤（原来归档、类别、会话过滤对语义通道无效）；带类别过滤的召回先筛后截。另：语义命中的理由从 `deep` 改成新增的 `semantic`，模型不再被告知「这是一次模糊的深层回忆」。

- **model：推理强度「关」现在真的关掉推理（09-16 13:00，5c651c3d、74b04649）。** 原来对 Anthropic、OpenAI、Google、OpenRouter 四家都不生效，仍在发推理参数。改法逐家按各自 API 语义定：Anthropic 发厂商的关闭写法（省略参数不等于不思考，新一代默认自适应思考）；OpenAI、Google 一个推理参数都不发（两家都没有覆盖全部推理模型的通用关闭写法，发错整条请求会被拒）；OpenRouter 用路由层自己的开关。**请求字节只在这一档变**，其余档位一字未动，按字节钉住的基线查过没有需要改的；切到「关」会让该会话的前缀缓存失效一次。另：缺 key 的提示语改成「请在产品模型设置中补充」，Velar 向量接口改走宿主注入的认证请求，baseURL 末尾多余的斜杠全部去掉。

- **project 的模型面参数普遍缺字段级说明，随契约那一轮补齐（09-16 13:30，你提出）。** 实测渲染后的入参 schema：project 九个工具共 **147 个字段没有说明**（read 5、list 6、search 8、file 13、edit 12、code 71、change 27、run 2、sandbox 3）；同样口径下 system 只有 3 个。两边的做法本来就不同——system 每个字段各写一句，project 把规则写在工具说明正文里，结果是模型填参数时看不到字段自己的说明，缺省值、单位、上限也无处可查（评审 P9–P12 记的「递归缺省只下 3 层」「搜索缺省不区分大小写」等都属于这一类）。规则定为：字段说明写「是什么、缺省是什么、上限多少、填错会怎样」，跨字段的流程规则留在正文、不重复。另外 system 仅有的那 3 个（入参复用信封的 `changes[].op`/`path`/`value`）来自 agent 的公共包装，在 agent 那一轮补，两个空间一起受益。

- **system:read 的字符预算改成按行截断（09-16 13:10）。** 原来按字符硬切，正好切在半行上；代码本来就是按行的，模型拿到半行要么看不懂要么得再读一次。现在预算没取完时只给完整的行（末尾带换行），`range.end` 落在下一行行首、续读接着走；某一行本身比预算还长时才从行中间截（否则这一次读一个字都给不出来）。project:read 本来就是这么做的，只是说明里没写，随契约那一轮补上——两个空间的说法就统一了。影响：模型面 `maxChars` 的说明多一句；同一预算下返回的字符数可能略少于 maxChars。

- **模型面两处形状变更，随契约那一轮一起改（09-16 12:45，你拍板）。** ① `project:read` 只收 `files` 与 `continuation`，删掉顶层 `path`、`range`——读单个文件写成只有一项的 `files`，与 `system:read` 同形（ADR 0004）。② `project:change` 的步骤改成按动作的判别联合（`action: create|overwrite|move|delete|recode|edit`），删掉 `tool` 字段，一步一个目标，同一文件内的多处编辑仍在 `edits` 里。影响：模型面入参形状变了（说明、示例、schema 同改，指纹重算）；宿主里按 project:read 顶层 `path` 或按 `step.tool` 拼入参的地方要跟着改，属于产品层，本仓不动、改完列出调用点。

- **新包 `@velaros-ai/text-files`：文本文件的编码识别、编解码与原子读写合成一份，system 的读写行为因此变了几处（09-16 00:30，b9c2746e、6b6bbf2a、d769bfad、95bcd6ca，ADR 0008 附录）。** 以 project 那份为底。system 看得到的变化：① GBK/GB18030 文件能读能改（原来读成乱码，整份写入还会把 GBK 文件悄悄改存成 UTF-8），读结果的 `encoding` 可能是 `gb18030`；② 既不是合法 UTF-8 也解不成 GB18030 的文件按二进制报错，不再「读成功带替换字符」，全局搜索跳过它们、沙箱差量不附文本；③ 新文本里有孤立代理项整批拒写（原来悄悄写成替换字符）；④ **多硬链接的文件拒改**（原来原子替换会让它和其余链接悄悄分家）；⑤ 写入 fsync，已有文件的权限位原样保留（原来会被 umask 收掉位），新建文件按 umask（022 下仍是 0644）；⑥ 回滚到认不出是文本的版本，改为计划期拒绝（原来先写进去再报失败）。project：根入口不再导出 `ProjectTextEncoding`（宿主改用 `@velaros-ai/text-files/contracts` 的 `TextEncoding`），三句报错文字变了、两处 reason 变了（读事务原字节时路径变成目录或管道：CONFLICT_WITH_EXTERNAL_EDIT → NOT_SUPPORTED；流式解码中途文件被改坏：裸 TypeError → NOT_SUPPORTED）。顺带修掉 Bun 下 GB18030 流式解码在 64 KiB 块边界丢字的问题。

- **浏览器提取的修复并回主线（09-16 00:40，6cb36d4e）。** 原在未合并分支 `fix-browser-extract-save`（10f3f726）：`browser:extract` 与 `export_page` 把求值信封当载荷，save 从不落盘、表格截到 100 行、长正文整份丢。补丁原样打到 main，browser 测试 94 条过，分支按「用完即删」删掉（原提交在 reflog 里）。配方步骤里的同类问题由 browser 修复这一路一起修。

- **agent 改造的方向与几处结构裁决（09-15 23:45，方案在第 1 步之后执行）。** 目标与 system、project 同一套：src 收成 contract/types/impl/utils/exports，impl 按域分 19 个子目录、13 层；**对外入口从 23 个收成 4 个**（`.`、`./contracts`、`./chat`、`./tool-contract`），这一步删入口与大量没人用的导出，按 `check:agent-public-api` 的规矩是破坏性变更，agent 升 1.0.0，放在第 6 步一次做，并附逐符号迁移表；前 5 步只动包内，Desktop、Workbench、Termel 不受影响。我替你拍的板：① 协议里 70 个 `z.infer` 推导的类型改成手写类型、schema 用 `satisfies z.ZodType<…>` 编译期对齐（不给门禁开 schema 例外）；② 可移植数据全部进 `types/agent.ts` 一个文件，core 的 `SerializedError`、`ErrorCode` 放同形副本、仓库层一致性测试守；③ **工具契约（`./tool-contract` 与工具相关的协议类型）是否拆成独立包 `@velaros-ai/tool-contract`，第 6 步收口时再定，我倾向拆**——六个空间包现在只为写工具就把整个 agent 运行时列为 peer 依赖；④ 发请求字节会变的「空间知识搬家」（源码视图、验证账本搬进 project）单独放第 8 步，不和搬家混；⑤ agent 工具面的删改（删 `context:distill`、合并 `goal:get`/`plan:get`、删 `tooling:map` 的 `op=read` 等候选）在第 5 步单独一个提交，届时逐条写进这里。第 1 步已完成（18ad853f、da737f17）：去掉 213 条包名自引用与 29 个中间 barrel，入口改成逐个名字的显式转发，导出名一个不变（agent 0.6.32，基线按「只增不删」重绑：85 个符号的声明文本因 tsc 输出的成员顺序、import 路径不同而变，逐个核过语义等价）。

- **project 迁入两个公共件，修掉三个缺陷（09-15 23:11，ADR 0008 附录）。** ① 沙箱落回：原来确认用的是截断到 2000 条的差量、落回却全部落，也不核对确认之后镜像有没有再变；现在向宿主要完整差量（`diffSandbox({ maxFiles: Number.MAX_SAFE_INTEGER, textDiffs: false })`），确认文案按完整三列算，`applySandbox` 带上差量指纹。**宿主契约变化**：`ProjectSandboxPort` 改为扩展 `RehearsalSandboxHostPort`，`diffSandbox` 要认 `textDiffs`、差量要带 `fingerprint`，`applySandbox` 要认 `fingerprint`（Desktop 用系统本地内核实现时这些已经支持）；`ProjectSandbox*` 九个数据类型改从 `@velaros-ai/rehearsal-sandbox/contracts` 取。② 经内核按名调用 project 工具时，原来先解析宿主上下文、后校验入参（和它自己的注释相反），现在先校验；入参不合法报 `VALIDATION`（和 system、office 一样），不再伪装成项目领域的 `INVALID_INPUT`。③ 沙箱 source 写 `..cache` 这类以 `..` 开头的项目内目录不再被误拒。
- **project:run 的判定改用公共判定，行为有两处变化（09-15 23:11）。** project 原来那份只读判定多一道兜底正则：命令里出现 delete、exec、remove、write、okdir 这几个词就判「会改项目」，所以 `grep -rn delete src` 这类只读命令也要过项目修改授权、不能并发；公共判定按参数逐条否决，这类命令现在判只读。危险命令确认文案在递归删除时多一句「如果目标是一个项目或仓库目录（含 .git），未推送的提交和未提交的改动会一起没掉，无法找回」（ADR 0004 的承诺，system 早就有）。
- **project 工具的「适用」一节不再是占位句（09-15 23:11）。** `defineProjectTool` 原来给没写的说明节塞通用句（「需要完成该工具职责所描述的项目操作。」「目标不属于当前项目边界。」等五句），它们原样进了 read、list、search、file、edit、change、run、code-analysis 八个工具的提示词。现在只写真有内容的节：这八个工具各补了一句真正的适用场景，其余占位句删掉。提示词审核指纹要等 agent 第 1 步提交后在干净工作区重算（指纹也登记了 agent 源文件）。

- **project 正式纳入门禁（09-15 23:02）。** 模块卡片、12 条不变量（验收 10 条全经根入口测试）齐了，登记表去掉「迁移中」，门禁与 system 一样零条。
- **project 注入面与产品面收窄（09-15 23:02）。** 工具从来不调、内核从来不读的成员删掉：`AgentProjectKernelPort` 的 `resolveTarget`、`fixTransaction`、`validate`、`diff`（领域内核 `ProjectKernel` 上照旧有，宿主直接调内核不受影响）；`ProjectCodeIntelligenceHost.available`（内核只看 `isProjectEnabled`）；`CreateProjectKernelOptions.metadata`；`SandboxProvider` 与 `ProjectProviders.sandbox`（全仓和两个产品没有一个插件用）。`ProjectKernel` 去掉 `createTaskContext`、`getJournal`（全仓与 Desktop、Workbench 零调用）。影响：宿主实现这些端口时可以少写几个成员；Desktop 代码智能后端上的 `available` 字段多写着也无妨。
- **project 模型看得到的 14 条报错与回执改成中文（09-15 23:02）。** fileRef、续读引用、历史快照授权、文件上下文登记、编辑目标、引用存储不可用等，原文与新文逐条见提交 25393627 的说明；另有 ripgrep 超时诊断改中文（project:search 不转发它，直接调内核的宿主看得到）。命令、路径、错误码、字段名没动。

- **project 事务状态文件无效时的报错改成中文（09-15 22:32）。** `Invalid project transaction state: …` → `事务状态文件无效：…`；冒号后面的具体原因（`transaction status/appliedAt mismatch` 这类）暂保持英文，因为它们同时写进 `details.stateValidationFailure`、测试按字串匹配，下一轮连同字段一起改。

- **新包 `@velaros-ai/rehearsal-sandbox`：沙箱数据形状、上限与「确认的就是要落的」落回规则抽成公共件（09-15 22:31，ADR 0008 附录）。** system 已改用它：`@velaros-ai/system` 不再导出 `SystemSandbox*` 九个数据类型和 `SystemSandboxLimits`，宿主改从 `@velaros-ai/rehearsal-sandbox/contracts` 取 `SandboxRecord`、`SandboxDiff`、`RehearsalSandboxLimits` 等（字段完全一样）。模型与用户看到的没有变化（system 的确认文案原样搬过去，末句参数化）。project 迁过来时顺带修掉它「确认用截断差量、落回却全落」的缺陷。

- **工具集合挂进内核的那段逻辑收进 `@velaros-ai/agent/tool-contract`，office 的报错跟着变成中文（09-15 22:19）。** `parseToolWireInput`、`createToolCallableOperations` 取代 system、office 各自的一份（project 那份在它整理完后换）：先严格解析入参、再向宿主解析上下文（坏入参不会触发宿主解析）、核可用、核取消、执行，工具抛的错可交给 `mapError` 翻译。影响：office 经内核调用时的报错从英文（`Office capability input is invalid` 等）变成「办公能力的入参不合法：…」这类中文；system 的文字不变。agent 升 0.6.31，公开 API 基线按只增不减重绑（基线在这之前就已落后 6 个声明，一并绑上）。

- **新包 `@velaros-ai/shell-command`：命令判定从 system 抽出来，新开「能力公共件」一域（09-15 22:15，ADR 0008）。** 只读、危险、长驻判定，并发判定，确认文案，危险命令的审批请求（操作身份跨工具一致）都在这一个包里；system 已改用它，project 在实现层整理完之后迁过来。影响：`@velaros-ai/system` 不再导出 `systemCommandPolicy`、`SystemCommandPolicyApi`、`SystemCommandExecutionPlan`；Desktop、Workbench、Termel 的命令判定改从新包取（对照表在 ADR 0008）。模型看到的没有变化（system 的判定原样搬过去）。**要你拍板的两件事留着没动**：project:run 要不要像 system:run 一样对长驻命令（`npm run dev` 这类）弹低风险确认；危险命令被拒时 system 抛错、project 返回结构化拒绝，要不要统一。
- **仓库里两个测试的假路径换成 example 用户（09-15 22:15）。** `check:public-readiness` 把 macOS 家目录下的具体用户名当开发者本机路径拦下（system 修复代理新加的用例和一个 UI 渲染测试），只改测试数据。

- **project 的错误原因做成合同常量表，删掉六个从没出现过的码；宿主端口去掉 codeAnalysisAvailable（09-15 21:58）。** `ProjectErrorCodes`（14 个码，每个写明含义）进 `@velaros-ai/project/contracts`，宿主按码分支有了单一出处。`LOW_CONFIDENCE_TARGET`、`ANCHOR_MISMATCH`、`PATCH_PARSE_ERROR`、`POSTCONDITION_FAILED`、`FORMATTER_CHANGED_TOO_MUCH`、`TEST_FAILED` 全仓没有一处产生、也没有一处判断，删了（合同不该承诺永远不会出现的码）。`ProjectToolApi.codeAnalysisAvailable` 工具从来不调，只有 Desktop 自己在 manifest 里调它当可用性判断；可用性本来就由宿主传给 `createProjectCodeAnalysisTools(isAvailable)` 的回调决定，端口上这一项多余。影响：Desktop 那行 `context.project.codeAnalysisAvailable?.()` 要改成宿主自己的判断。

- **project 的入口收成两个，公开面按「包自己用得上」重划（09-15 21:54）。** 和 system 一样只剩 `@velaros-ai/project`（Node 宿主）与 `@velaros-ai/project/contracts`（可移植数据）；`/files`、`/changes`、`/execution`、`/runtime`、`/agent`、`/composition`、`/kernel`、`/transaction-controller` 都删了。产品（Desktop、Workbench）要跟着改 import，对照如下：
  - 换了形状的：`registerProjectFileContext(ctx)` → `projectFileContext.register(ctx)`（返回是否登记上）；`installProjectApprovalProvider` / `withProjectApproval` → `projectApprovalBridge.install(kernel)` / `.run(ctx, action)`；`new FileProjectChangeFeed({ path })` → `createFileProjectChangeFeed({ path })`；有限事务面的接口改名 `ProjectTransactionControllerApi`（工厂名不变）；`isProjectCodeLanguageQuery` → 常量表 `ProjectCodeLanguageActions`；`PROJECT_PACKAGE_VERSION` → `ProjectPackageVersion`。`createProjectKernel`、`typescriptPlugin`、`createSecretRedactionProvider`、`createProjectSpace`、`projectTools` 等从根入口取。
  - 不再导出、等第三步抽公共包的：命令判定（`analyzeCommandExecution`、`isShellCommandLikelyMutating`、`buildBackgroundCommandConfirmationMessage` 等）将进新包 `@velaros-ai/shell-command`；路径包含判断（`isPathInsideProjectRoot` 等）将进 platform。
  - 删掉的（project 自己一处都没用，是产品主进程和渲染进程之间的数据形状）：57 个宿主数据类型（`ProjectGit*`、`ProjectReadFileResult`、`ProjectRootEntry`、`ProjectInfo`、`ProjectFileEntry` 等）、`ProjectRootSource` / `isProjectRootSource`（值就是 `ProjectSpaceId`）、目录可见性表（`ProjectExcludedDirectoryNames`、`shouldSkipProjectDirectory` 等）。**设计点**：Desktop 文件树用的跳过表和模型 list/search 实际用的排除规则（gitignore 加内置排除 glob）本来就是两套，删掉之后更明显；要不要让界面和模型看到同一套，是产品层重构时要定的。
  - 不再导出的实现细节：各工具的 zod schema（入参类型照旧导出）、`executeAgentProjectRead` 等单个执行函数、`finalizeProjectModelResult`、`ProjectError` 类（宿主按错误码判断）、`DEFAULT_CORE_POLICY`、`ToolContext` 别名、`VelaToolSurface`。
- **project 工具说明里的数字改引常量表，模型看到的两处小变化（09-15 21:54）。** 新增常量表 `ProjectFileLimits`、`ProjectChangeLimits`、`ProjectCodeLimits`、`ProjectCommandLimits`、`ProjectSandboxLimits`、`ProjectTransactionLimits`、`ProjectToolExposure`（工具排位，数值不变），schema 和说明都引它们。模型看到的变化：project:read 的用法从「range（51 或 [42,45]）」改成「range（单个行号或 [首行,末行]）…最多 20 个文件」；project:run 的 timeoutMs、maxOutputChars 补了和 system:run 一样的字段说明。宿主代码查询的形状 `ProjectCodeQuery` 从 zod 推导改成显式类型，放进可移植数据。提示词审核指纹已重算。

- **project 的工具定义收进一个文件，read/search 的说明与 read 的参数报错改成中文（09-15 21:28）。** 九个工具加 project:code-analysis 的全部定义（说明、schema、示例、权限、能力声明）现在都在 `packages/project/src/impl/ProjectTools.ts`，按读取、改动、代码理解、执行四类排，文件末尾是分组、内置 mod、内核模块和项目空间的组装；execute 各一行，交给 `impl/operations/` 里的六个执行类。模型看到的变化只有两处：project:read、project:search 的摘要和用法原来是英文，改成中文；read 参数校验的四条报错改成中文。工具名、字段名、示例不变。提示词审核指纹已重算。
- **宿主契约：项目工具上下文不再带 `system` 字段（09-15 21:28）。** `ProjectToolContext.system`（只有一个 `canStartBackgroundCommands`）删了，和 system 包按 ADR 0003 删掉同名开关一致：宿主不能或不允许跑后台命令，就在 `project.runCommand` 里以 PERMISSION 拒绝。子代理的边界原来只包了 system 端口的 runCommand，project:run 靠那个开关挡后台命令；开关删了以后我把 agent 包的子代理边界扩到 project 端口（`LoopRuntime.withoutBackgroundCommands`，加了测试），子代理经 project:run 起后台进程仍然被拒。代价：危险命令加后台加子代理这种组合，用户会先看到确认卡，确认后才被拒。
- **project 的入口不再导出单个工具的 schema（09-15 21:28）。** `ProjectCodeSchema`、`ProjectCodeAnalysisSchema` 从 `@velaros-ai/project/contracts` 和 `/agent` 撤掉（入参类型 `ProjectCodeInput`、`ProjectCodeAnalysisInput` 照旧导出）；要 schema 的宿主从工具集合里取 `projectTools['project:code'].schema`。`executeProjectRead` 等单个执行函数也撤了，统一走 `projectCodeOperations` 和 `createProjectCallableOperations`。仓库里没有外部调用方。

- **project 删掉第 1 版模型工具与入参迁移（09-15 21:00）。** project:write、project:rollback、project:query-code 和按行号改的旧版 project:edit/read 不再由生产包提供；第 1 版失败调用迁移成第 2 版复用的逻辑也删了。影响：升级前开始的老会话里模型不能再调旧版工具（新会话本来就只看得到第 2 版）。旧版工具整体挪进 packages/project/test/support/ 当测试驱动器，那 6 个测试文件照旧跑，测的仍是生产里的内核、事务与文件上下文行为。
- **收编的遗留功能改变了模型在失败后看到的内容（09-15 20:18）。** 修改类调用失败且确证没写入时，紧接着的那一次决策里模型看到完整的原参数（上限 32000 字符），不必先召回正文；再往后恢复省略形态。project 的提示词审核指纹因此重算（提示词本身没变，变的是指纹登记的两个 agent 源文件）。
- **system 的报错与提示统一成中文（09-15 20:14）。** 模型会看到的报错、edit 的问题清单、失败回执里的建议下一步、沙箱冲突说明、shell 自检原因共 80 多处从英文改成中文；命令、路径、错误码、字段名不变。工具说明本来就是中文，现在同一个回执里不再中英混排。影响：宿主若按英文报错文本做判断会失效，应改按错误码（`SYSTEM_SHELL_UNAVAILABLE` 这条原先被标成「英文文本是公开契约」，已改口）。

## 决策记录

| 时间 | 决策 | 理由 |
| --- | --- | --- |
| 09-16 17:50 | **用户拍板**：取消 `src/exports/` 目录，入口文件直接放 `src` 根（`src/index.ts`、`src/contracts.ts`…），`src` 下从五个目录变四个加入口文件；等当前四路包内改造落地后全仓一次改完 | 只放转发语句的目录是多余的一层；多入口保留的唯一理由是运行环境隔离（可移植入口要能被渲染进程加载），其余能并的都并 |
| 09-16 17:20 | 用户把剩下的拍板项全权交给我，逐条裁决写进 `foundation-pending-decisions.md` 的「裁决一览」：大项是 agent 入口收口 1.0.0 与工具契约拆包、kernel 入口 12→5 并删 HostBridge/sidecar、memory 拆出 knowledge 包、browser 工具面 40→32、三个能力包收口，公共件三件进拆出来的 tool-contract | 包内步骤先走完再统一收口，产品只迁一次；kernel 的 `./contracts/abi` 被八个能力包引用，它的收口排最前 |
| 09-16 16:55 | **用户拍板**：project 工具面归并 J1–J5——改动三合一收成 `project:edit`（action: apply/inspect/undo）、`project:code` 改 9 个命名意图、`project:code-analysis` 保持独立、`project:list` 的 recursive+maxDepth 收成 `depth` | `change` 本来就是 `file ∪ edit` 的超集，模型每次改代码都要先做一道无谓的选择题；`project:code` 70 多个字段全无说明、旋钮交叉，模型基本只能瞎填 |
| 09-16 16:55 | **用户立的两条规矩进标准**（`module-ownership.md` 规矩 2、3）：① 写一堆说明不如写清楚示例——先给能照着填的真实示例，说明只补示例讲不出来的；② 一件事只给一个入口，批量维度只留一个字段名 | 模型填错的代价是重来一轮；条文写得再全也不如一个能照抄的例子 |
| 09-16 14:40 | 「目录被忽略则里面的一切被忽略」按各级上级目录推，不再展开成 `pattern/**` | 展开会让名叫 `build` 的**文件**被 `build/` 命中；git 的语义是目录限定 |
| 09-16 14:10 | 撤销历史预算定 48 MiB（内存与状态文件共用），未应用的事务与待恢复的事务永不淘汰 | 单文件读取上限 5 MiB，一个大事务记账约 25–38 MiB；48 MiB 能留住 1–2 次大改动，同时离 256 MiB 硬顶足够远，保证「历史大小永远不会让 apply 失败」 |
| 09-16 12:45 | **用户拍板**：`project:change` 的步骤改成按动作的判别联合（create/overwrite/move/delete/recode/edit），删掉点名别的工具的 `tool` 字段，一步一个目标 | 原形状把外部批量藏进工具内部：批量嵌三层、判别字段直接写 `file`/`edit` 两个工具名，评审也发现它没有任何说明。批量维度收成 `steps` 一个 |
| 09-16 12:45 | 定下批量的判据：批量做进工具只在批量本身有语义时（读＝共享预算与同一个续读句柄；写＝一次事务：全成或全不成、一次确认、一个撤销句柄）；没有事务语义的尽力而为批量写不做；不做通用的「批量调用」工具 | 运行时本来就能一轮发多个调用；包一层之后风险判定、审批文案、回执形状糊在一起，用户看不清在批准什么。批量字段是常驻上下文成本，为方便加不划算，为事务或预算加才划算 |
| 09-16 12:30 | **用户拍板**：`project:read` 改成只收 `files` 与 `continuation`，删掉顶层 `path`、`range`，与 `system:read` 同一形状 | ADR 0004 定的「单个和一批用同一种形状，不另设顶层字段」；顶层字段只是少打一层括号，却多一条互斥规则和一条报错。随契约那一轮一起改，宿主按顶层 path 拼入参的地方要跟着改 |
| 09-16 12:10 | 子代理的任务书改成草稿区里的文件（`scratchpad/main/prompts/*.md`），派单时只给路径 | 09-16 01:00 前后 9 路子代理因 opus 周额度用尽同时中断，重派要把长说明再写一遍；写成文件后中断可原样重派 |
| 09-16 12:10 | 中断留下的 agent 半成品（5 个文件的类型归位）核过测试、公开 API 与门禁后收成提交，不回退 | 它自洽且方向正确（第 3 步前半的开头），回退等于白丢 |
| 09-16 00:40 | memory、browser 的实现层缺陷在改造之前先修（memory 三条 P0 是路径穿越与凭据注入），model、office、computer 的实测缺陷排在它们之后 | 缺陷修复不动入口与导出名，和后面的搬家互不影响；安全问题不该等结构改完 |
| 09-16 00:30 | text-files 的 system 新建文件不传 mode、按 umask 建（没按我原先说的 0644） | 传 mode 会绕过 umask 精确设上，umask 077 的用户会建出所有人可读的文件；022 下结果相同 |
| 09-16 00:30 | text-files 的按块解码用本包自己的解码器，不直接用 `TextDecoder` | 实测 Bun 1.3 的 `TextDecoder` 流式解 GB18030 会丢块边界上的字、末尾残缺不报错 |
| 09-16 00:15 | project 复查的两份评审（实现层 14 条加 1 条疑似、产品层 49 条）分三路修：① 路径规则公共包加路径身份类问题（别名、大小写、沙箱源目录、`.git` 默认禁写）；② 持久化与执行类问题；③ 契约与提示词，放在前两路之后 | ①② 改的文件基本不相交可以并行；③ 和 ② 都要改执行类与回执，串行免冲突；路径身份问题的根因（按字面判断路径）正好用新加的 core `RealPath` 与 platform 包含判断修 |
| 09-16 00:15 | 产品层评审建议的「project:read 只收 files」不做，只记下来 | 你说过 project 的工具面不简化；这条是形状统一（与 system:read 一致），牵涉宿主，留给你定 |
| 09-16 00:10 | `check:host-contract-consumer` 的打包表从写死八个包改成沿依赖递归补齐第一方包 | project 迁入两个公共件后闭包缺包就红了；以后新增公共件不必回来改表 |
| 09-16 00:05 | agent 第 2 步整文件搬家合成一个提交；`AppRuntimeFacts`、`StatefulToolResults` 这类方案要删的文件先保留到 utils | 公开 API 基线的声明哈希对搬家敏感，拆提交就要多升版本；删文件会让导出名消失，属于第 6 步的破坏性变更 |
| 09-15 23:45 | 文本文件的编解码、原子写、有界读、流式读抽成新包 `@velaros-ai/text-files`（以 project 的实现为底），报错用本包自己的码当 `AppError.code`；project 在一处把它翻成 `ProjectError`，现有 `instanceof ProjectError` 的分支一个不改 | project 那份全面更健壮（GB18030、严格解码、fsync、权限位精确恢复、拒绝多硬链接）；project 里 190 处按 `ProjectError` 分支，边界翻译最小改动 |
| 09-15 23:45 | 换行适配（CRLF 文件里的匹配与替换）不合并，各空间保留自己的 | 语义不同：system 按原文主流风格统一新文本，project 只在匹配时适配，合并会改两边的编辑行为 |
| 09-15 23:45 | agent 方案 3.5 节的 8 处结构冲突按方案建议走（类型手写 + satisfies、可移植单文件、入口平铺四个、1.0.0 放第 6 步、空间知识搬家放第 8 步、工具面删改单独提交）；工具契约拆不拆包第 6 步再定 | 用户授权自行决策；拆包牵动六个空间包与产品的 import，放到入口收口时一次改 |
| 09-15 23:40 | agent 第 1 步不按「脚本 / 自引用 / barrel」拆三个提交 | 中间状态的 public-api 基线哈希各不相同，每拆一个提交就要多升一次版本 |
| 09-15 23:40 | agent 测试加 `standaloneModuleImport.test.ts`：每个入口和每个源文件在全新进程里单独 import | 原代码有 4 个模块单独加载时报 TDZ（循环引用），去 barrel 后归零，靠它防回潮；代价是测试从约 3 秒变成 5.5 秒 |
| 09-15 23:30 | browser、memory、kernel 三个包先出只读改造方案（同 agent 方案的格式），执行时照方案分步推 | 这三个包合计 8 万行，先摸清消费方与耦合再动，和 agent 并行不冲突 |
| 09-15 20:05 | 收编此前会话留下的 9 个未提交文件（agent 的失败调用原参数还原 + 两个测试），单独提交 5df228b | 用户确认没有会话在跑；改动完整、测试通过，丢掉会损失一个已做完的功能 |
| 09-15 20:05 | 模型看到的文字（工具说明、报错、建议的下一步）统一中文，命令、路径、错误码、字段名保持原样 | 工具说明已是中文，报错中英混杂读起来割裂；用户未反对默认做法 |
| 09-15 20:05 | 其他包的工具面按 system 的判据简化：别的工具替代得了、只剩仪式感的才删；模型没用过但有独特能力的不删 | 用户要求简化工具面；判据沿用已定的 system 做法 |
| 09-15 21:00 | 旧版工具不直接连测试一起删，而是挪进 test/support 当驱动器 | 6 个测试文件借旧版工具测真行为，改写成第 2 版 fileRef 流程成本高；挪走后生产面干净、覆盖不丢，以后可以逐个改写 |
| 09-15 21:00 | ProjectError 暂留、挪进 utils/errors.ts，门禁允许 utils 放只有字段的错误类 | 190 处抛出、agent 的纠错逻辑读它的字段，一并换成 AppError 牵连太大；是否统一成 AppError 另行评估 |
| 09-15 23:02 | 删掉 project 的命令校验器与 prettier/eslint 修复器及其预设（CommandValidator、PrettierFixer、EslintFixer、command-checks） | 自 80c8e7de（8 月把 validationPlugin 入口删掉）起没有任何入口能用到，一个半月没人发现；要找回就从那个提交之前取 |
| 09-15 23:02 | 删掉 `createFileFilterProvider`、`createAllowAllPolicyProvider` 与路径包含判断的三个旧函数 | 全仓与两个产品零引用（Desktop 仍 import 那三个路径函数，但根入口早已不导出，属于产品层重构时的接线；第三步会在 platform 提供统一的路径包含判断） |
| 09-15 23:02 | 只有测试在用的第 1 版协议（`utils/edit-intent.ts`、`utils/agent/edit-target.ts`、`EditTarget`）挪进 `test/support` | 生产包里不留只为旧测试服务的代码，测试照旧用它们驱动内核 |
| 09-15 23:02 | 模型入参的 `ProjectCodeScope` 与宿主查询的 `ProjectCodeLanguageScope` 合成一个 `ProjectCodeScope`（放在可移植数据里） | 字段一模一样，一个概念两个名字 |
| 09-15 23:02 | 登记为 project 复查轮的待办：utils 里的模块级可变状态（`file-refs` 没有载荷存储时的进程内兜底、glob 与 JS/TS 解析的记忆化缓存）；门禁收紧「utils 不存状态」 | fileRef 兜底存储是有语义的状态，改法牵涉整个 Agent 适配层；记忆化缓存不改变结果，门禁收紧时要给它留口子 |
| 09-15 22:32 | project 事务状态文件的格式上限（Maximum*）归为可调参数进 `ProjectTuning.persistence`，并写明「不能小于内核保留的事务数」 | 它们跟着内核的事务保留数与宿主策略走，不是对外承诺；格式版本号属于格式规则，留在校验旁边 |
| 09-15 22:32 | 删掉 `PluginRegistrySink`，插件登记表直接收 `ProjectPluginContext` | 两者形状一模一样，一个概念两个名字 |
| 09-15 22:22 | 门禁加「迁移中」状态与 `--only`/`--list`：迁移中的包照查照报条数、不计入失败；每个包的 ✓ 不再被前面包的失败吞掉 | project（以及之后的 agent）改造期间就能登记、看燃尽，登记表不用一直挂在工作区里不提交 |
| 09-15 22:15 | 公共件单独成域 `foundations`，不进 core、不进 platform、不登记进能力归属表 | core 要零依赖无领域语义，platform 按 ADR 0005 不判断命令危险；公共件被多个能力空间依赖，登记成能力 owner 会被判跨 owner |
| 09-15 22:15 | shell-command 的判定取 system 那份，project 的兜底正则迁移时删掉 | system 那份逐参数否决、没有误报，确认文案带 ADR 0004 承诺的仓库提醒；兜底正则把 `grep -rn delete src` 判成要修改授权 |
| 09-15 22:15 | 并发判定参数化（optIn），不在这次统一两个空间的缺省 | system:run 的 schema 有 parallel 字段、要求显式声明；project:run 没有这个字段、只读即并发；统一与否是产品决定 |
| 09-15 22:15 | 审批请求只出「文案 + 选项」，被拒语义留给空间 | system 被拒抛错、project 返回 skipped，两种都有测试钉着；公共包只保证操作身份一致 |
| 09-15 21:58 | 门禁再放宽两处：utils 可以放只有字段、写了中文说明的错误类；宿主端口「工具真会调」的核对从工具文件出发沿相对 import 走到 impl 与 utils，端口字段名可登记 | ProjectError 被 utils 里上百处抛出，utils 又不许引 impl；project 的端口调用在 utils/agent 里，只看工具文件和它直接委托的类会误报「没人调」 |
| 09-15 21:58 | project 实现层达标拆给四个并行子代理：内核与文件、事务与持久化、策略插件适配器、工具函数与合同文档；各自只改自己的目录，用临时索引提交 | 约 700 条门禁问题、互相之间多为纯机械工作；按目录切开冲突最少，共用索引的提交竞态用临时索引规避 |
| 09-15 21:54 | 门禁放宽一条：合同文件可以 `import type` provides.ts 登记过的类上方接口 | 项目空间（`ProjectSpace.kernel`）要引用领域内核的接口；接口按规矩写在类上方，合同里只能引用它，不能搬走 |
| 09-15 21:54 | 有限事务面和落盘变更记录保留并改成类加工厂，没有删 | 眼下产品没用，但它是给界面那一侧的最小权限面（拿不到内核），产品层重构接 IPC 时正用得上；实例上用 `#` 私有字段存内核，测试钉住「没有可枚举状态、只有五个方法」 |
| 09-15 21:54 | 旧版工具驱动器定义完之后把全局示例表还原成现行工具的示例 | 旧版有三个工具和现行同名，定义时覆盖全局示例表，谁先加载决定别的测试读到哪版示例，全量跑时偶发失败 |
| 09-15 21:54 | 声明搬家脚本修一处：类的 `extends` 按值引用处理 | 原来当成类型位置，搬走的子类被补成 `import type` 父类，运行时报错 |
| 09-15 21:28 | project 的工具定义收进 `impl/ProjectTools.ts` 一个文件，重实现搬进 `impl/operations/` 的六个执行类（文件、改动、执行、代码、执行门、审批桥） | 和 system 同一套：工具文件只放定义、execute 不超过 4 句；原来 14 个工具文件、9 个 schema 文件、3 个组装文件各管一片，改说明要跳 3 处 |
| 09-15 21:28 | project:edit、project:file、project:change 三个入参 schema 在工具文件里具名导出 | 编辑类工具的 schema 会被 agent 的 `withToolInputReuse` 包成 pipe，测试要断言原始对象形状，只能拿到未包装的那个 |
| 09-15 21:28 | 执行门（同一项目根的读写排队）从模块级函数改成 `ProjectExecutionGate` 类，由三个执行类构造注入 | 一类一文件、类上方写接口；测试可以各建一个门互不干扰 |
| 09-15 20:05 | 公共逻辑的去处由我定：system 与 project 共用的部分进按含义新建的包，不塞进 platform | 用户授权；platform 只管跨平台兼容，一包一义 |

## 进度

- [x] ① system 结构复查（386ea2d、114a6c3、d692e79）
- [ ] ② system 复查修 bug（已完成：18 条，9 个提交 21fcb91…c8a2983）、定为仓库标准（已完成）；project 改造（已完成：工具面 8d7513e、入口 bc93fd0、错误码 1ea639d、实现层四路、卡片与不变量，门禁零条）；project 复查修 bug（两份评审已回，修复排队中）
- [x] ③ 公共逻辑抽取（已完成：shell-command、rehearsal-sandbox、内核可调用操作表进 agent/tool-contract、project 迁入、text-files、platform 路径包含判断 c9564d45、core 真实路径 7c39d5c9；进行中：path-rules 与两边迁移；待做：工具定义辅助与内核模块样板、工具失败构造器）
- [ ] 其余包：方案全部写完并归档在 `refactor-plans/`；缺陷修复已完成 model、memory、office、computer、browser、kernel、project（七小包在跑）；agent 第 1–3a 步完成、3b 在跑；browser、memory 包内改造第一段完成。等你拍板的项汇总在 `foundation-pending-decisions.md`：agent → browser → memory → kernel → model → office → agent-lab → development → core → html-artifacts → computer → cli → document-renderer → surface-protocol

**停在这里（09-16 17:12，全量 `bun run check` 退出码 0、工作区干净）。** 这一段共 101 个提交、1446 个文件、+78,949 / −46,625。
- 缺陷修复全部完成：project（实现层 14 条 + 产品层 49 条）、memory（3 条 P0 安全 + 16 条）、kernel（24 条，含权限闸绕过与守护进程起不来）、browser（11 条）、office/computer（9 条）、model（6 条）、七个小包（15 条）。
- 公共件：shell-command、rehearsal-sandbox、text-files、path-rules 四个新包，外加 platform 的路径包含判断与 core 的真实路径。
- 结构改造：system、project 达标；agent 第 1–4 步（第 4 步差常量表收尾）；browser、memory 完成包内第一段。
- 模型面：project 九个工具收成七个、说明 6,436 → 4,663 字、147 个字段说明补齐、指纹已重算。
- 等你拍板的项在 `foundation-pending-decisions.md`，方案与评审底稿在 `refactor-plans/`。
