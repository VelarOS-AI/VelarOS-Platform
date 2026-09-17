# 文件能力不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；新增一条同样要点名。
检验方式与 `packages/system/spec/invariants.md` 相同：测试 / 类型 / 门禁 / 运行时 / 文字，`check:module-ownership` 核对每一行的检验器是否存在。

编号只增不重排。INV-1～INV-4、INV-6～INV-10 的承诺原来登记在 `@velaros-ai/system`（INV-20/21/22/31/33/34），`velar:system` 拆成跨空间的 `velar:files` 与 `velar:shell` 之后，文件那一半随实现搬到这里；作用域与策略由空间注入（INV-5）是拆出来之后新立的承诺。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | `edit` 一批一次成败：任何一个写不下去（版本对不上、不是文本、编不回原编码、同一个文件出现两次）就一个文件都不写，错误码是 `FILES_EDIT_UNRESOLVED`，message 逐条写明第几个文件、为什么 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 落盘时把计划时看到的字节交给空间核对（新建的核对它仍不存在）：审批期间文件被同尺寸、同修改时间地改掉也不覆盖；写到一半出错时，message 点名哪几个已经写进去了 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 文本改动无损：只按认得出的编码（UTF-8、带 BOM、UTF-16、GB18030）严格解码，写回原编码，编不成的整批不写；已有的二进制文件不许被 `newText` 覆盖；符号链接写到它指向的文件、链接本身不变；改动前的内容留成版本，能读回、能回滚，回滚本身也能再回滚 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 大文件分三档：不超过 20 MB 的整份读、整份写（超过 2 MB 的写了不留版本）；更大的读写都拒，报错指向用命令取片段或就地改；一批读好几个时，读不下的那个单独算失败，**绝不回半份**。读的字符预算与文件字节上限是**同一个数** | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 作用域与策略由空间注入、不由模型挑：越出空间范围的路径读的那一项失败、写的那一批整批不写（`FILES_EDIT_DENIED`）；空间要问的按真实路径问，第一次被拒就停、后面的不再打扰，整批不写；读被拒只是那一项失败 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 代码面的 `files` 命名空间是一条真路：模型写的程序照生成的 `baselines/code-surface/files.d.ts` 过 typecheck，在隔离里读真文件、在程序里筛、只交出要的；12 MB 的正文穿过隔离读改写，模型只看到一行摘要；写不下去时程序接得住，看得见的就是 `error.code` 与 `error.message` | 测试 | `spec/acceptance.test.ts` |
| INV-7 | 入参不合法由操作方法自己拦，不靠调用方：形状不对（不是对象、files 不是数组、空批、项不是对象、path 不是字符串、超过批量上限、两种改法同时给）一律 `VALIDATION`，不会半途崩 | 测试 | `spec/acceptance.test.ts` |
| INV-8 | 看图只做模型做不了的两件事：把像素交到模型眼前、把图压进 API 的上限。在上限以内（长边 2000 px、base64 后 5 MB）的图**原样交出、不碰缩放器**；超了才请空间压，要了 `region` 才请空间裁，整块在图外直接拒。图走代码面的图片通道，结果里只有原图尺寸与实际给出的尺寸，没有像素。空间压不了就明说并给出命令；没有交图通道时 view 不可用 | 测试 | `spec/acceptance.test.ts` |
| INV-9 | 代码模版（`templates/files.js`）是一整份能照抄的程序，import 只写一次；它**整份照生成的真实声明过类型检查**，并且原样嵌在声明的模块头里 | 测试 | `spec/acceptance.test.ts` |
| INV-10 | 模型面与常量表一致：声明里写的批量上限、文件与图片上限、两个错误码都与 `FileLimits`、`FileErrorCodes` 对得上；空间端口与调用上下文不进模型面 | 测试 | `spec/acceptance.test.ts` |
| INV-11 | 文件分工与对外边界不塌（同 system 的 INV-16）；`./contracts` 入口整条引用链不碰 Node 内置模块，渲染进程可以直接加载 | 门禁 | `check:module-ownership` |
