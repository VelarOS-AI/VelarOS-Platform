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
