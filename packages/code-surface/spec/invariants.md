# 代码面不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；新增一条同样要点名。
检验方式与 `packages/system/spec/invariants.md` 相同：测试 / 类型 / 门禁 / 运行时 / 文字，`check:module-ownership` 核对每一行的检验器是否存在。

编号只增不重排。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 先检查后执行：程序是 JavaScript，但**照样过 TypeScript 的检查**（`checkJs`，类型从生成的声明推）；没过时程序**一行都不执行**，回的是诊断而不是结果；诊断的行号与模型写的那一行对得上，中间不转译所以行号不会错位 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 程序够不到宿主的环境能力：读写文件、起子进程在隔离里一律失败，程序只能经能力端口做事 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 到时必停：超过 `timeoutMs` 的程序一定被终止并回 `TIMEOUT`，死循环也不例外；`signal` 触发时同样停 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 拒绝是可捕获的异常：能力端口报错在程序里是一个能 `try/catch` 的 throw，不是一份静默的空回执；同一次拒绝会出现在回给模型的 `notices` 里 | 测试 | `spec/acceptance.test.ts` |
| INV-5 | `NodeSubprocessCodeRunner` 不许进正式发版：它挡不住网络（Node 的权限模型不覆盖 socket），`NodeSubprocessRunnerIsReleaseReady` 恒为 `false`，宿主装配时据此拦下 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 大字符串走 `blobs` 不进源码：含反引号、`${`、反斜杠、引号的内容原样送达程序，只过一层转义 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | 超预算不静默：返回值与日志超过上限时按**结尾**保留（失败现场在尾部），并在 `notices` 里说清省略了多少 | 测试 | `spec/acceptance.test.ts` |
| INV-8 | 程序源码与 blobs 超过体量上限一律拒，不截断后照跑——半截程序跑出来的结果比不跑更坏 | 测试 | `spec/acceptance.test.ts` |
| INV-9 | 隔离必须**自证**才接活：子进程启动后先真去做一次该被拒绝的动作，证不出被关住就不把程序发进去（fail closed）。只相信命令行旗标不算数——`fork` 缺省用 `process.execPath`，宿主跑在 bun 下时那是 bun，它忽略 `--permission`，看着正常而隔离一点没生效 | 测试 | `spec/acceptance.test.ts` |
| INV-10 | 手滑写了 TypeScript 不废掉一整轮：整份诊断都落在「这个语法只能在 TypeScript 文件里用」那一族时，按 TypeScript 再查一遍（真类型错照样拦），剥掉类型照跑，并在 `notices` 里告诉模型下次直接写 JavaScript | 测试 | `spec/acceptance.test.ts` |
| INV-11 | 改上一份程序不必整份重写：`edits` 照 `system:edit` 的协议（`oldText` 一字不差、范围里必须唯一、一组全成或全不成、各处不许重叠），**不用行号**——模型看不见自己刚写那段代码的行号。`source` 与 `edits` 只能给一个；传了 `edits` 却没有上一份时明确拒绝，不猜一份出来 | 测试 | `spec/acceptance.test.ts` |
| INV-12 | 诊断必须带代码帧：出错那一行连同一个指向出错列的插字符一起给出。只回行列号等于让模型靠数行定位，而数行是它最不准的事之一 | 测试 | `spec/acceptance.test.ts` |
| INV-13 | 非常驻能力必须先导入才能用：`import` 了没授权的模块时**一行都不执行**，回要补的命名空间让模型拿到签名再重写；没 `import` 直接用那个名字是干净的 `Cannot find name`，不是「要补模块」。检查器只加载「常驻 + 本会话已导入」，**不加载全量**——加载全量就把这道闸拆了 | 测试 | `spec/acceptance.test.ts` |
| INV-14 | 租约写在 `import` 的属性上、随程序一起带回来，**续租退租不独占一轮**；认不出的租约值当没写（不为一个拼错的字废掉一轮） | 测试 | `spec/acceptance.test.ts` |
| INV-15 | **我们发明的东西要导入，语言自带的不动**：`blobs` 走恒常授权的 `velar:program` 模块，不做隐形全局——隐形全局是只有提示词告诉过模型才知道的暗知识；`console` 是 JavaScript 自带的，不动。`velar:program` 不占授权名额、不参与租约与回收 | 测试 | `spec/acceptance.test.ts` |
| INV-16 | 没跑完就交账：程序中止、超时或抛错时，**已经落定的能力调用逐条回给模型**（连着的同名同结果折成一条带 `times`），跑完了不给。这是**账**不是事务——不承诺回滚（跑过的命令回滚不了），承诺**知道**：工具面里中断落在两次调用之间、天然干净，程序里落在执行中途，副作用是真的，只回一个 `ABORTED` 等于让模型对着三个字瞎猜 | 测试 | `spec/acceptance.test.ts` |
| INV-17 | 内存也要封顶：隔离进程带 `--max-old-space-size` 起，堆爆时回 `TOO_LARGE` 并说清怎么改，不报成「意外退出」。超时管得住死循环，管不住一个循环里把整个仓库读进数组；子进程 stderr 必须有人收（没人收会把它堵死，而堆爆的现场只在那里） | 测试 | `spec/acceptance.test.ts` |
