# 地基重构流水账（2026-09-15 起，马拉松授权）

用户授权：把 system 的规范推成全仓标准，依次处理 project、system 与 project 的公共逻辑、agent 及其余包（ui 不动）。
实现细节自行决策；产品层与设计相关的决定写在「需要你看的」里。每完成一部分提交一次，不推送。

顺序：① 复查 system 的结构 → ② system 实现层与产品层（输入输出契约）复查修 bug，定为仓库标准 → project 按同一套改造并复查 →
③ system 与 project 的公共逻辑抽出去 → 其余包（agent 优先，ui 不动）。

## 需要你看的（产品层、契约、提示词、工具面）

（按时间追加。每条写：改了什么、为什么、影响谁。）

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
