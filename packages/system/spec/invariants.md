# 系统空间不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；
新增一条同样要点名。

检验方式分五档，`check:module-ownership` 门会核对每一行的检验器是否真的存在：

| 检验方式 | 含义 | 检验器写法 |
| --- | --- | --- |
| 测试 | `spec/acceptance.test.ts` 里有以该编号开头的用例 | `spec/acceptance.test.ts` |
| 类型 | 由类型定义钉死，改不了 | `src/<文件路径>.ts::<类型名>` |
| 门禁 | 由仓库门禁脚本机械核对 | `check:<门名>` |
| 运行时 | 实现里有断言，违反即抛 `INVARIANT` | `src/impl/<文件>.ts` |
| 文字 | 目前只有文字描述，没有机器检验 | 留空 |

文字档在模块卡片的健康栏里显示为「未验证」，不算通过。

编号只增不重排，所以会有空号：
- INV-7/8/9/13/14/29 是工具面的承诺，随工具面一起作废。INV-1 曾是「与 project 空间判定一致」，那是跨包约束，已移到仓库级 `tests/capabilities/command-danger-parity.test.ts`。
- INV-2、INV-3、INV-18 随命令策略移到 `@velaros-ai/shell-command`。
- `velar:system` 拆成跨空间的 `velar:files` 与 `velar:shell` 之后，操作本身的承诺随实现搬走：INV-4（危险命令的审批形状）、INV-15（`nativeCommand` 不进模型面）、INV-32（上限归能力自己钳）到 `@velaros-ai/shell-command` 的 INV-7、INV-9、INV-6；INV-21、INV-22、INV-33 到 `@velaros-ai/files` 的 INV-3、INV-4、INV-9。INV-17（输出窗口的 `endPreserved` 恒为真）随 `outputWindow` 字段一起删掉：回执只留末尾这件事由 INV-10 管，模型面的说明写在 `ShellCommandResult` 上。
- 本包留下的是本机宿主的承诺（进程约束、输出、生命周期、shell 选择、演练沙箱引擎），以及系统空间的装配与端口（INV-19、INV-20、INV-31、INV-34、INV-35）。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-5 | 受约束的进程模式没有可用后端时失败关闭，拒绝执行而不是退回裸进程 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 约束证据如实上报：审批事实与约束事实分开记录，未受约束就写 `enforcement: none`，不冒充隔离 | 测试 | `spec/acceptance.test.ts` |
| INV-10 | 输出超过上限时回执只留**末尾**且末尾真实，`truncated` 为真：失败现场在尾部，砍头不砍尾；转后台的命令回执里带 `taskId`，按它查得到那条任务 | 测试 | `spec/acceptance.test.ts` |
| INV-11 | 管道分块不会打碎 UTF-8 字符，子进程退出码原样透传，shell 描述符里不带 `env` | 测试 | `spec/acceptance.test.ts` |
| INV-12 | 超时或取消后进程管理最终收敛：终止信号无人响应、close 永不到达时也在期限内结束，并如实标记清理未完成 | 测试 | `spec/acceptance.test.ts` |
| INV-16 | 文件分工与对外边界不塌：合同只有产品面登记、注入面、常量表三个文件且接口的每个成员有中文说明，类型目录一个值都没有、公开数据不带函数成员；实现目录扁平、一类一文件、类实现接口且公开成员不超出接口、按登记分层引用；utils 只放带中文说明的函数与常量；对外入口只转发，导出的类型只来自公开接口与数据、导出的值只能是按公开接口标注的实例与工厂或契约常量表；系统空间的宿主接口每个方法都有装配表在调；环境变量全部登记；渲染进程可加载的入口不碰 Node 内置模块 | 门禁 | `check:module-ownership` |
| INV-19 | 系统空间写系统敏感路径与凭证文件前按解开符号链接后的真实路径向用户确认，被拒整批不写（`FILES_EDIT_DENIED`）；读凭证文件同样要问，被拒只是那一项失败；临时目录不打扰用户 | 测试 | `spec/acceptance.test.ts` |
| INV-20 | 系统空间的落盘核对计划时的字节：审批期间文件被同尺寸、同修改时间地改掉，也不覆盖（`VALIDATION`，message 说明被别人改了） | 测试 | `spec/acceptance.test.ts` |
| INV-23 | 演练沙箱里的命令一律受进程约束：cwd 落在镜像根之内就只能写镜像和它自己的临时目录；没有约束后端的宿主建不出沙箱，不留没有约束的副本；清单读不出来时镜像根里的命令拒绝执行，不退回裸进程 | 测试 | `spec/acceptance.test.ts` |
| INV-24 | 落回只写清单记过的文件：源目录里任何一处自建沙箱以来变过就整批不落（`SYSTEM_SANDBOX_CONFLICT`，not-applied，冲突列在 message 与 context 里）；任何一层的 `.git`（含嵌套仓库）永远不落 | 测试 | `spec/acceptance.test.ts` |
| INV-25 | 丢弃沙箱只删沙箱基目录下面正好一层的目录：id 不合形状、这一项是符号链接、路径解开链接后不在基目录之下或就是基目录本身，一律拒绝 | 测试 | `spec/acceptance.test.ts` |
| INV-26 | 镜像仓库推不出去：镜像里每个仓库（含嵌套仓库、子模块）的每个远端都被改成无效的推送地址，节头写法（CRLF、大小写、尾随空白、旧式 `[remote.x]`）不影响；指向源目录外真实仓库的 `.git` 链接文件不进镜像；网络缺省切断 | 测试 | `spec/acceptance.test.ts` |
| INV-27 | 落回只落用户确认过的那份差量：确认之后镜像又变过就整批不落（`SYSTEM_SANDBOX_CHANGED`，not-applied） | 测试 | `spec/acceptance.test.ts` |
| INV-28 | 落回只写在源目录之内、要么全落要么报清落了哪些：上级路径是符号链接或文件（又不在这次删除之列）按冲突整批不落；内容先暂存，拷不全什么都不落；挪到位途中失败在 message 与 context.applied 里点名已落回的路径 | 测试 | `spec/acceptance.test.ts` |
| INV-30 | 命令只在挑定的那个 shell 里跑：`shell` 给的种类本机没有就在起进程之前拒绝，报错点名可用的有哪些、哪个是默认，绝不换默认 shell 照跑；不给 `shell` 才用默认的那个 | 测试 | `spec/acceptance.test.ts` |
| INV-31 | 系统空间的操作表正好是 `files`、`shell`、`sandbox` 三个命名空间，每个命名空间登记的名字与生成声明里的函数名逐个对上（一边有另一边没有都红）；表这一侧没有校验、没有给模型的字——入参合不合法由那件能力自己拦 | 测试 | `spec/acceptance.test.ts` |
| INV-34 | 系统空间的缩图裁图在 macOS 上用系统自带的 `sips`，**裁与缩分两次调**（它不管参数顺序都先缩后裁），尺寸由 sips 自己报；超长边的图压到上限以内，裁出来的一块不被放大；别的平台不给这个口子 | 测试 | `spec/acceptance.test.ts` |
| INV-35 | 系统空间是一条真路：模型写的程序照三份生成的声明过 typecheck，经真实的本地内核读写文件、跑命令、用演练沙箱；相对路径相对内核的工作目录，命令在本机跑，沙箱能镜像任意目录、镜像里的命令写不到外面、落回前按源目录问用户 | 测试 | `spec/acceptance.test.ts` |
