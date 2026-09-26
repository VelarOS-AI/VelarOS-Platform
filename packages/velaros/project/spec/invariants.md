# 项目工具不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；新增一条同样要点名。
检验方式与 `packages/agent/spec/invariants.md` 相同：测试 / 类型 / 门禁 / 运行时 / 文字，`check:module-ownership` 核对每一行的检验器是否存在。

迁到代码面之后（模型写程序、import `velaros:project` 与 `velaros:code`），承诺照旧按编号保留：INV-1 从「七个工具」改成「两个命名空间」，失败回执里的 `not-applied` 与入参复用随工具面一起退场——代码面只把 `error.code` 与 `error.message` 交给程序（INV-20）。INV-15 早已作废，编号不复用。

项目空间与两件工具分开之后，属于空间的承诺搬去了项目空间包（`@velaros-ai/project`）的登记表：原 INV-7（项目里的危险命令）、INV-16（沙箱落回的写治理）、INV-21（项目里看图）是那边的 INV-2、INV-4、INV-5，原 INV-14、INV-17 里「沙箱源目录、命令工作目录钳在项目内」那一半并进了那边的 INV-3。这三个编号在这里作废，不复用。

2026-09-18（ADR 0009）权限与脱敏整个拆掉，五条改写：INV-10（生成文件不许手改）、INV-14（`.git` 缺省不许写）、INV-17（改动问修改授权）、INV-19（像密钥的片段遮住、只读）原来的承诺作废，改成反过来的承诺；INV-13 去掉「拒读拒写名单」那一半，宿主的过滤器只管列举。
原来这几道闸拦不住任何事——同样的读写 shell 不经确认就能做——却让模型读到 `[REDACTED]` 改不了文件、改生成物被拒、每次改动等人点头。

2026-09-18：`@velaros-ai/project`（项目空间）整包拆掉：装配表（`createProjectSpace`）离开本仓库，空间由产品自己装；给三件共用能力装项目端口的那一半搬回本单元，
成了 `projectCapabilityPorts`（连同交给 agent 编码会话的验证判据 `projectVerificationPolicy`），宿主端口 `ProjectHostPort` 也登记在本单元的注入面。
那边登记表的 INV-2、INV-3、INV-4、INV-5 随端口搬回来、接着编号，成了这里的 INV-26、INV-27、INV-28、INV-29，改由 `projectCapabilityPorts` 配上三件能力真实的操作来测；
它们本来就是从这里的原 INV-7、INV-16、INV-21（以及原 INV-14、INV-17 的一半）搬过去的；INV-7、INV-16、INV-21 照旧作废、不复用。
那边的 INV-1（空间挂五个命名空间、模块清单）随装配表作废；INV-6（入口门禁）由本单元的 INV-12 管着，不另立。

2026-09-27（ADR 0023）读改协议改成连续正文、按路径写：read 与 search 交回的窗口是一段连续的正文（`text`，带第一行的行号 `startLine`），不再是逐行的 `[行号, 正文]`，也不再交出 `fileRef`；
edit 的步骤只剩 write、replace、move、delete、recode，全按路径指文件，replace 按原文定位。读取凭据还在，只是由 edit 自己按路径去取，不经模型的手。
原来改一处要先抄 fileRef、数行号、写 range，一处定不下来整轮弹回——模型写起来比改文件本身还费劲。
随之 INV-2、INV-3 改写：INV-2 从「只认读取回执里的 fileRef」改成「按路径写、后一步接着前一步」；INV-3 原来的承诺（读取之后外部改过就整批拒绝）作废——
编辑作用在提交那一刻的内容上，replace 要换的原文还在就照样成立、外部改动保住，原文被改没了才拒绝；write 是整份换掉，和 shell 的重定向一样不核对读过的版本，被换掉的内容由这次改动的撤销记录找得回来。
INV-18（读完之后被改过时给出新行号重提）作废、编号不复用：按原文定位之后没有「旧行号」这回事。INV-4、INV-19、INV-20、INV-23、INV-24 去掉 fileRef 与「第几处」的说法。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | `velaros:project` 有六个操作（read、list、search、edit、inspect、undo）、`velaros:code` 有两个（query、analyze），声明从源码生成、只放出这些，调用上下文与空间端口不进模型面；两件工具随包发布的声明（`VelarProjectModule`、`VelarCodeModule`）与生成物是同一份，放出的方法就是能调的那些 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 编辑按路径写：write 把正文整份写进一个文件（不存在就新建，上级目录自动建），replace 把文件里唯一的一段原文换成新文；同一次 edit 里对同一个文件接连几步时，后一步按前一步改完的内容算，move 之后按新路径接着改 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 编辑作用在提交那一刻的内容上：读取之后外部改了文件的别处，replace 照样成立、外部改动保住；要换的那段原文被外部改没了就整批拒绝（TARGET_NOT_FOUND），一个字节都不写 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 一次 edit 是一个事务：几个文件、几步全成或全不成；定不下来的那一步在 message 里点名第几步（`steps[i]`） | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 撤销只撤本事务写下的内容：遇到之后的外部修改拒绝覆盖（CONFLICT_WITH_EXTERNAL_EDIT）；已经撤销过的再撤一次是幂等成功，不报错也不改坏东西 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 读、列、搜、改都只在项目根之内：越出项目的路径（包括经符号链接指到项目外）一律拒绝（PERMISSION_DENIED） | 测试 | `spec/acceptance.test.ts` |
| INV-8 | 同一项目根上写操作串行、读操作可并发；排队的写者不被后来的读者饿死，取消了的等待者不运行 | 测试 | `spec/acceptance.test.ts` |
| INV-9 | 文本改动无损：保留文件原来的编码、BOM 与换行，没改到的字节原样保留；新建文件是无 BOM 的 UTF-8、LF；只有 recode 动作改磁盘编码 | 测试 | `spec/acceptance.test.ts` |
| INV-10 | 没有生成文件名单：生成出来的文件（`*.generated.*`、`generated/` 下这类）也改得动；声明里提醒一般该改生成器的输入再重新生成，改不改由程序定 | 测试 | `spec/acceptance.test.ts` |
| INV-11 | 错误原因只来自合同常量表 `ProjectErrorCodes`，程序与宿主按码分支，不按文字 | 类型 | `contract/constants.ts::ProjectErrorCode` |
| INV-12 | 根入口只出产品面、注入面和它们用到的数据；`./contracts` 的整条引用链不碰 Node 内置模块，渲染进程可以直接加载 | 门禁 | `check:module-ownership` |
| INV-13 | 同一个物理文件的项目内别名（符号链接、大小写变体）算同一个文件：一次事务里两个入参指向同一份内容时，在写任何东西之前整批拒绝（INVALID_INPUT）；宿主的列举过滤器只管列举、扫描与搜索，按请求路径和解开符号链接后的真实路径各问一次（经链接的别名也列不出来），点名读写从不问它 | 测试 | `spec/acceptance.test.ts` |
| INV-14 | 没有读写名单：`.git` 里的、`.env` 这类照常能读能写，只受根内约束（INV-6） | 测试 | `spec/acceptance.test.ts` |
| INV-17 | 改动与撤销不问人：调用上下文里没有审批端口，空间端口里没有授权口子；回滚恢复不了原文的写入照样记成 high 风险（给界面与审计看），照常写盘 | 测试 | `spec/acceptance.test.ts` |
| INV-19 | 读出来的就是原文：像密钥的片段不遮，照读到的原文写 replace 照常能改；搜索片段取命中所在的行，行太长时以命中为中心收窄，命中一定在片段里 | 测试 | `spec/acceptance.test.ts` |
| INV-20 | 程序看得到的只有 `error.code` 与 `error.message`：code 是 `ProjectErrorCodes` 的原因码，details 里的位置（第几步）、候选、诊断、改完之后的预览与下一步都写进 message | 测试 | `spec/acceptance.test.ts` |
| INV-22 | 两份代码模版（`template.js`、`code-template.js`）是日常用法的示例程序（只是示例，模型按需要改写、不要求照着写），import 只写一次；它们整份照生成的真实声明过类型检查，不嵌进声明，随模型面发布、按需读（`velaros:system` 的 modules.describe）；在真的空间里把每个函数跑一遍、看交回的是不是它说的样子，由仓库层的 `tests/capabilities/capability-templates.test.ts` 核对 | 测试 | `spec/acceptance.test.ts` |
| INV-23 | 行号照 `wc -l` 数，和 `velaros:files` 一样：结尾换行之后那个零宽的行不算进 totalLines（空文件是 0 行），越出行数的说明也照它数；读到文件末尾的窗口，正文结尾的换行照原样在，整份读回来原样 write 回去不多一行也不少一行；停在空行上的范围照样交出那一空行 | 测试 | `spec/acceptance.test.ts` |
| INV-24 | 什么都不折叠，看多少由程序定：read 交回要的整段（不给 range 就是整个文件，没有续读），list 交回全部条目（不给 depth 就是整棵树，没有分页），search 交回全部命中、每个命中的文件一段命中处（连同前后几行）的连续正文，edit 与 inspect 交回完整差量，`velaros:code` 不按条数截；只有守内存的上限（`ProjectFileLimits.readChars`、`listEntries`、`searchHits`，`ProjectCodeLimits.results`），超了明说（SCOPE_VIOLATION，或宿主标的 coverage.truncated），不交回一部分冒充全部 | 测试 | `spec/acceptance.test.ts` |
| INV-25 | 声明里写给模型的上限就是常量表 `ProjectFileLimits`、`ProjectCodeLimits` 与缺省策略里的数：改常量不改说明（或反过来）过不了验收 | 测试 | `spec/acceptance.test.ts` |
| INV-26 | 项目里的危险命令每次都由用户亲自确认（高风险、手动、不可记忆，确认文案说「当前项目」，风险分类 `project-command:dangerous`）；被拒时抛错、一个进程都不起；别的命令（会改项目的、长驻的也一样）不问，直接跑，输出原样交回 | 测试 | `spec/acceptance.test.ts` |
| INV-27 | 命令的工作目录与演练沙箱的源目录按解开符号链接后的真实路径钳在项目之内：出了项目在问用户之前就拒绝（`PERMISSION`），一个进程都不起、什么都不镜像；项目里的交给宿主时是解析好的绝对路径 | 测试 | `spec/acceptance.test.ts` |
| INV-28 | 演练沙箱落回不问人、不按名单拦：点名的路径核过（点名了没变化的就拒绝，`VALIDATION`）就把同一份差量的指纹交给宿主落回；镜像里命令的输出原样交回 | 测试 | `spec/acceptance.test.ts` |
| INV-29 | 项目里看图（共用的 `velaros:images`）只看项目里的图：出了项目（含经符号链接指到外面）的那一张看不了（`PERMISSION`），项目里的都照常交给模型 | 测试 | `spec/acceptance.test.ts` |
| INV-30 | 语言查询只借读源码端口（`listFiles` / `read` / `listSymbols`）：不消耗项目的修改、执行与审批能力，宿主给的内核就算带着写入口本包也够不着 | 测试 | `spec/language-acceptance.test.ts` |
| INV-31 | 代码图谱后端不可用时内置的七个语言动作照常可用，代码图谱类动作抛 code 为 `UNAVAILABLE` 的错误（project 据此降级，而不是当成查询失败） | 测试 | `spec/language-acceptance.test.ts` |
| INV-32 | 空结果不伪装成「全部通过」：没扫到文件、文件数被截断、耗时超预算、标准库缺失，一律写进 `note` / `degraded` | 测试 | `spec/language-acceptance.test.ts` |
| INV-33 | 目录诊断按文件所属的 tsconfig 分组，同一个文件在目录模式与单文件模式下得到一样的诊断 | 测试 | `spec/language-acceptance.test.ts` |
| INV-34 | 外部语言服务只启动规格表里给的命令，只解析项目根以内的文件；命令没装时给不出诊断，但这次结果仍标为完整（是没有诊断能力，不是等到超时） | 测试 | `spec/language-acceptance.test.ts` |
| INV-35 | 路径越界按**真实路径**判定：项目里名叫 `..xxx` 的目录照常查询，经符号链接指到项目外的路径一律拒 | 测试 | `spec/language-acceptance.test.ts` |
| INV-36 | `find_references` 提前停扫时引用数是下限：`referenceCountIsLowerBound` 为真且 `note` 里写明，不把下限当总数交给模型 | 测试 | `spec/language-acceptance.test.ts` |
| INV-37 | 认不出的 `language` 当场失败并列出可用值，不静默选中零个服务返回一份看似「没有结果」的空答复 | 测试 | `spec/language-acceptance.test.ts` |
| INV-38 | TypeScript 语言服务池可以被宿主释放：`typeScriptProjects.release()` 之后旧凭据自报失效，调用方按 `isCurrent()` 重新取 | 测试 | `spec/language-acceptance.test.ts` |
| INV-39 | `./project/contracts` 入口整条引用链不碰 Node 内置模块，渲染进程与浏览器都能加载；语言服务实现、工具函数与内部接口一律不出包 | 门禁 | `check:module-ownership` |
| INV-40 | 语言查询的注入面只借内核的三个读方法，多一个都借不到：类型上就是对 `AgentProjectKernelPort` 取 `listFiles`、`read`、`listSymbols` 三键的 `Pick` | 类型 | `contract/requires.ts::LanguageReadPort` |
| INV-41 | 同一份内容搜两遍，交回的一样：命中同分按路径、再按行列排，不跟 ripgrep 多线程交回的次序走（结果进模型上下文，次序抖动既让模型看着乱，也坏了前缀缓存） | 测试 | `spec/acceptance.test.ts` |
