# 文件能力不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；新增一条同样要点名。
检验方式与 `packages/agent/spec/invariants.md` 相同：测试 / 类型 / 门禁 / 运行时 / 文字，`check:module-ownership` 核对每一行的检验器是否存在。

编号只增不重排，所以会有空号。INV-1～INV-4、INV-6、INV-7、INV-9、INV-10 的承诺原来登记在 `@velaros-ai/system`（INV-20/21/22/31/33/34），`velar:system` 拆成跨空间的 `velar:files` 与 `velar:shell` 之后，文件那一半随实现搬到这里；作用域与策略由空间注入（INV-5）是拆出来之后新立的承诺。

之后 `velar:files` 重做成系统空间自己的本机文件能力（项目里的文件改走 `velar:project`），读写从整份改成按行，看图拆了出去。编号照旧，没有重排，每条按新设计重写：
- INV-8（看图）作废：看图成了独立的 `velar:images`，承诺搬到 `@velaros-ai/velar/images` 的登记表。
- INV-3 原来的后半「改动前的内容留成版本，能读回、能回滚，回滚本身也能再回滚」作废：读历史版本与 `restore` 换成整次撤回 `undo`（INV-13），撤回本身不再记成一次能撤的改动。INV-4 里「超过 2 MB 的写了不留版本」随之改成「这次改动撤不回」，归 INV-13。
- INV-12（行的数法与按行改）、INV-13（整次撤回）是这次新立的。

2026-09-18 INV-5 的后半「空间要问的按真实路径问，第一次被拒就停……撤回被拒就不撤」作废：读写前问人的钩子（`reviewRead`、`reviewWrite`）整个拆掉了。
系统空间里 shell 本来就能不经确认读写凭证文件与系统敏感路径，这道确认拦不住任何事，只会打断模型；INV-2 里「等用户确认期间」随之改成「计划之后、落盘之前」。

2026-09-18：`@velaros-ai/system` 整包拆掉，系统空间的文件端口成了本单元的本机文件端口（`createLocalFilePort`，连同给宿主界面的全局搜索），值从只给 Node 的 `./local` 入口出。
端口的承诺随实现搬来、接着编号：INV-14、INV-15、INV-16 依次是 system 原来的 INV-19、INV-20、INV-36，意思不变，主语从「系统空间」换成本机文件端口；
INV-15 顺带写进「新建的核对它仍不存在、缺的上级目录补建」，端口这一侧原来没验过。
门禁行 INV-11 原来写「同 system 的 INV-16」，那一行随 system 一起没了，改成直接写出它管的几件事，并补上「本机实现只在 `./local` 入口」一句。
system 原来的 INV-31（系统空间的操作表与模块清单）、INV-35（经系统空间跑一段真程序）随装配表作废：空间由产品自己装，仓库层的 `tests/capabilities/capability-templates.test.ts` 用测试装配接着核对那一份。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | `edit` 一批一次成败：任何一个文件写不下去（版本对不上、不是文本、编不回原编码、行号越界或重叠、同一个文件出现两次——写法不同或经符号链接指向同一个的也算）就一个文件都不写，错误码是 `FILES_EDIT_UNRESOLVED`，message 逐条写明第几个文件、为什么，版本对不上的带上现在的版本；写得下去就整批一次交给空间落盘，files 与入参一一对应，给一个 changeId | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 落盘时把计划时看到的字节交给空间核对（新建的核对它仍不存在，撤回核对撤回前读到的字节）：计划之后、落盘之前文件被改过——哪怕同尺寸、同修改时间——也不覆盖；写到一半出错时，message 点名哪几个已经写进去了，并给出能把它们整次撤回的 changeId | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 文本无损：只按认得出的编码（UTF-8、带 BOM、UTF-16 两种字节序带不带 BOM、GB18030）严格解码、按原编码写回，编不回原编码的与带 NUL 的新内容整批不写，不静默换成替换字符；图片、PDF 与其他二进制读是那一项失败（图片指向 `velar:images`），已有的二进制文件不许被覆盖；符号链接读写它指向的文件、链接本身不变；没动的行留着自己的换行符，新写的行与整份写的 newText 按文件为主的换行风格存，新文件照写；文件结尾有没有换行，改完照旧 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 大小分档：单个文件 20 MB 以内（正好 20 MB 也算）整份读、整份改；多一个字节读写都拒，报错指向用命令取片段或就地改；一批读好几个时，读不下的那个单独算失败，**绝不回半份**，单独放进一次 read 照样读得下。读的字符预算与文件字节上限是**同一个数** | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 作用域由空间注入、不由模型挑：越出空间范围的路径（经符号链接越出去的也算）读的那一项失败（`PERMISSION`），写的那一批整批不写（`FILES_EDIT_DENIED`）。空间端口只管作用域与落盘，读写前没有问人的环节：凭证文件、系统敏感路径照常读、改、撤回 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 代码面的 `files` 命名空间是一条真路：模型写的程序照生成的 `baselines/code-surface/files.d.ts` 过 typecheck（形状写错的一行都不执行），在隔离里经空间的操作表读真文件、按行改、撤回；十几 MB 的正文穿过隔离，模型只看到 export default 交出的那一点；写不下去时程序接得住，看得见的就是 `error.code` 与 `error.message` | 测试 | `spec/acceptance.test.ts` |
| INV-7 | 入参不合法由操作方法自己拦，不靠调用方：一批的形状不对（不是对象、files 不是数组、空批、项不是对象、超过批量上限）一律 `VALIDATION`，碰不到空间；读的一项不合法（path 不是字符串、range 不是合法的行号）只那一项失败；写的一项不合法（两种改法都给或都不给、newText 不是字符串、edits 形状不对）进 `FILES_EDIT_UNRESOLVED` 的问题清单；undo 没给 changeId 是 `VALIDATION`；抛出来的一律是带码的错误，不会半途崩 | 测试 | `spec/acceptance.test.ts` |
| INV-9 | 代码模版（`template.js`）是日常用法的示例程序（只是示例，模型按需要改写、不要求照着写），import 只写一次；它**整份照生成的真实声明过类型检查**，不嵌进声明，随模型面发布、按需读（`velar:program` 的 template）；在真的空间里把每个函数跑一遍、看交回的是不是它说的样子，由仓库层的 `tests/capabilities/capability-templates.test.ts` 核对 | 测试 | `spec/acceptance.test.ts` |
| INV-10 | 模型面与常量表一致：声明里写的批量上限、单个文件上限、留原文的上限、留几次改动与三个错误码都与 `FileLimits`、`FileErrorCodes` 对得上；声明里只有 `read`、`edit`、`undo` 三个方法，空间端口与调用上下文不进模型面，看图指向 `velar:images` | 测试 | `spec/acceptance.test.ts` |
| INV-11 | 文件分工与对外边界不塌：合同只有产品面、注入面、常量表且接口成员都有中文说明，类型目录一个值都没有，实现一类一文件、按登记分层引用，对外入口只转发，空间端口的每个方法都有操作在调；`./contracts` 入口整条引用链不碰 Node 内置模块，渲染进程可以直接加载；本机实现（本机文件端口、全局搜索）的值只在只给 Node 的 `./local` 入口 | 门禁 | `check:module-ownership` |
| INV-12 | 行的数法和 `wc -l` 一样（结尾的换行不多出一行，最后一行没换行也算一行）：`read` 交回 `[行号, 原文]` 与整个文件的 version，range 末行超出就收到最后一行、首行超出就那一项失败；`edits` 的行号都按 read 那一版算、给的顺序不要紧，几处不许重叠（插入点落在被换掉的几行中间也算），重叠的整批不写；按行号改必须带 version | 测试 | `spec/acceptance.test.ts` |
| INV-13 | 整次撤回：`undo` 凭 changeId 把一次改动整次撤回——改过的回到改动前的字节，那次新建的删掉，经符号链接改的写回它指向的文件；那之后有一个文件又被改过或不在了就整个拒绝（`FILES_UNDO_CONFLICT`），一个文件都不动；撤过的再撤一次成功且什么都不动（`alreadyUndone`）；改之前超过 2 MB 的原文不留，那次改动 `undoable` 为 false、undo 报 `VALIDATION`；只留最近 50 次改动，更早的与号不对的都是 `NOT_FOUND` | 测试 | `spec/acceptance.test.ts` |
| INV-14 | 本机文件端口读写凭证文件与系统敏感路径不问用户（ADR 0009）：私钥、`~/.ssh`、`/etc` 这些照常读、改、撤回，经符号链接的也一样（读写它指向的文件，链接本身不变）；调用上下文里没有审批端口，问人只在危险命令上（`velar:shell`） | 测试 | `spec/acceptance.test.ts` |
| INV-15 | 本机文件端口的落盘核对计划时的字节：定下改法之后文件被同尺寸、同修改时间地改掉，也不覆盖（`VALIDATION`，message 说明被别人改了）；新建的核对它仍不存在，落盘那一刻同名文件已经有了就不覆盖；缺的上级目录补建 | 测试 | `spec/acceptance.test.ts` |
| INV-16 | 本机文件端口的撤回写回改之前的字节、删掉那次新建的文件，删之前核对它还是那次写下的内容（对不上就不删，`VALIDATION`）；那之后别人又改过就整个不撤（`FILES_UNDO_CONFLICT`）；整份写照原文件的换行风格存 | 测试 | `spec/acceptance.test.ts` |
