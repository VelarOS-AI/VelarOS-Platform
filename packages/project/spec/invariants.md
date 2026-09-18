# 项目空间不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；新增一条同样要点名。
检验方式与 `packages/system/spec/invariants.md` 相同：测试 / 类型 / 门禁 / 运行时 / 文字，`check:module-ownership` 核对每一行的检验器是否存在。

迁到代码面之后（模型写程序、import `velar:project` 与 `velar:code`），承诺照旧按编号保留：INV-1 从「七个工具」改成「两个命名空间」，失败回执里的 `not-applied` 与入参复用随工具面一起退场——代码面只把 `error.code` 与 `error.message` 交给程序（INV-20）。INV-15 早已作废，编号不复用。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 项目空间挂五个命名空间（`project`、`code`、`shell`、`sandbox`、`images`）；项目独有的是 `velar:project` 的六个操作（read、list、search、edit、inspect、undo）与 `velar:code` 的两个（query、analyze），声明从源码生成、只放出这些，调用上下文与宿主端口不进模型面 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 编辑只认本会话读取、搜索或编辑回执里的 fileRef：它绑定路径、版本和实际交给程序的那段源码；range 越出这段就整批拒绝（SCOPE_VIOLATION），文件一个字节都不变；整份替换（overwrite）要求 fileRef 覆盖全文，move、delete 只核对版本 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 文件在读取之后被外部改过，基于旧版本的编辑整批拒绝（BASE_REVISION_MISMATCH），不覆盖外部改动 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 一次 edit 是一个事务：几个文件、几处编辑全成或全不成；定不下来的那一处在 message 里点名第几步第几处 | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 撤销只撤本事务写下的内容：遇到之后的外部修改拒绝覆盖（CONFLICT_WITH_EXTERNAL_EDIT）；已经撤销过的再撤一次是幂等成功，不报错也不改坏东西 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 读、列、搜、改都只在项目根之内：越出项目的路径（包括经符号链接指到项目外）一律拒绝（PERMISSION_DENIED） | 测试 | `spec/acceptance.test.ts` |
| INV-7 | 项目里的危险命令每次都由用户亲自确认（高风险、手动、不可记忆）；被拒时抛错、一个进程都不起；会改项目的命令先过宿主的项目修改授权，只读命令不打扰 | 测试 | `spec/acceptance.test.ts` |
| INV-8 | 同一项目根上写操作串行、读操作可并发；排队的写者不被后来的读者饿死，取消了的等待者不运行 | 测试 | `spec/acceptance.test.ts` |
| INV-9 | 文本改动无损：保留文件原来的编码、BOM 与换行，没改到的字节原样保留；新建文件是无 BOM 的 UTF-8、LF；只有 recode 动作改磁盘编码 | 测试 | `spec/acceptance.test.ts` |
| INV-10 | 命中项目策略 generatedFiles 的文件不许手改（GENERATED_FILE），下一步是改生成器的输入再重新生成 | 测试 | `spec/acceptance.test.ts` |
| INV-11 | 错误原因只来自合同常量表 `ProjectErrorCodes`，程序与宿主按码分支，不按文字 | 类型 | `src/contract/constants.ts::ProjectErrorCode` |
| INV-12 | 根入口只出产品面、注入面和它们用到的数据；`./contracts` 的整条引用链不碰 Node 内置模块，渲染进程可以直接加载 | 门禁 | `check:module-ownership` |
| INV-13 | 同一个物理文件的项目内别名（符号链接、大小写变体）算同一个文件：一次事务里两个入参指向同一份内容时，在写任何东西之前整批拒绝（INVALID_INPUT）；拒读拒写名单与宿主的可见性过滤器同时按请求路径和解开符号链接后的真实路径判，别名绕不过去 | 测试 | `spec/acceptance.test.ts` |
| INV-14 | 版本库内部（任意一层的 `.git`）缺省不许写，报错说清楚要用命令跑 git；演练沙箱的源目录解开符号链接后必须仍在项目之内，否则拒绝 | 测试 | `spec/acceptance.test.ts` |
| INV-16 | 演练沙箱落回过与编辑同一套写治理（越界、writeDeny、受保护文件、生成文件、宿主可见范围）：有一条不许写就在问用户之前整批拒绝并点名，一个文件都不落 | 测试 | `spec/acceptance.test.ts` |
| INV-17 | 项目的修改授权问在规划之后、写盘之前，并带上这次会写的文件（相对项目根）：宿主的确认卡片列得出要改哪些文件，被拒时一个字节都不写；命令的 cwd 出了项目在问用户之前就拒绝 | 测试 | `spec/acceptance.test.ts` |
| INV-18 | 文件在读完之后被改过、而原来要改的地方（连同前后的行）仍然唯一时，失败的 message 给出每处编辑的新行号与一个签了新 fileRef 的确认窗口；换上它按新行号重提就成，正文不用重写 | 测试 | `spec/acceptance.test.ts` |
| INV-19 | 读出来被遮住的内容（宿主的脱敏后端认出像密钥的片段）只能看不能改：窗口标 redacted、不签发 fileRef，遮住的原文不出现在交给程序的行里 | 测试 | `spec/acceptance.test.ts` |
| INV-20 | 程序看得到的只有 `error.code` 与 `error.message`：code 是 `ProjectErrorCodes` 的原因码，details 里的位置（第几步第几处）、候选、诊断、改完之后的预览与下一步都写进 message | 测试 | `spec/acceptance.test.ts` |
| INV-21 | 项目空间里看图（共用的 `velar:images`）只看项目里、项目读取策略许看的图：出了项目或在拒读名单里的那一张看不了（PERMISSION），别的照常交给模型 | 测试 | `spec/acceptance.test.ts` |
| INV-22 | 两份代码模版（`templates/project.js`、`templates/code.js`）是一整份能照抄的程序，import 只写一次；它们整份照生成的真实声明过类型检查，并且原样嵌在声明的模块头里 | 测试 | `spec/acceptance.test.ts` |
| INV-23 | 行号照 `wc -l` 数，和 `velar:files` 一样：结尾换行之后那个零宽的行不给模型看、不算进 totalLines（空文件是 0 行）；它仍在可见范围里，在文件末尾插入照样成立；按范围读到最后一行真实的行就是读到头，没有续读；停在空行上的范围照样交出那一空行 | 测试 | `spec/acceptance.test.ts` |
