# 看图能力不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；新增一条同样要点名。
检验方式与 `packages/system/spec/invariants.md` 相同：测试 / 类型 / 门禁 / 运行时 / 文字，`check:module-ownership` 核对每一行的检验器是否存在。

编号只增不重排。看图原来是 `velar:files` 的 view，承诺合在 `@velaros-ai/velar/files` 的登记表里（主要是那边的 INV-8）；拆成独立的 `velar:images` 之后随实现搬到这里并拆细：INV-1～INV-5 接过那边的 INV-8，INV-8、INV-11～INV-14 接过那边入参、代码面、模版、模型面、门禁几条里看图的那一半；INV-6、INV-7、INV-9、INV-10 是拆出来之后新立的。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 看图只做模型做不了的事，大多数图不用动：在上限以内（长边不超过 2000 px、base64 之后不超过 5 MB，都以 `ImageLimits` 为准，正好压线的也算以内）又没要 `region` 的图**原样交出、一个字节不动、不碰空间的缩放器** | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 超了才请空间压：长边或 base64 之后的体积任一超限，就请空间的 `resizeImage` 把原字节缩到长边 2000；交回的 base64 仍超就把长边再收一截重请，有限次数，压不进去报 `VALIDATION` 并指向换更小的 `region`。条目里的 `width`、`height` 是原图的，`sent` 与格式以空间实际交回的为准 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 要了 `region` 才请空间裁（在上限以内的图也照裁）：region 按原图像素算，超出图的部分先收进图里再交给空间；整块在图外直接拒（`VALIDATION`），不请空间 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 结果里只有尺寸、没有像素：成功的条目只有 `path`、`mediaType`、原图 `width`/`height` 与实际给出的 `sent`；图经调用上下文的 `attachImage` 交出（base64，已在上限以内），按批里的顺序、每张前面一行说明（第几张、哪个文件、原图多大、要了哪一块、给出多大），失败的那张不交 | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 做不了就明说，不悄悄交一张超限的图：空间没给 `resizeImage` 时，超限的图报 `PLATFORM` 并给出缩图命令（sips、ImageMagick），要 `region` 的报 `PLATFORM` 并指向先用命令裁；宿主没给 `attachImage` 时整个 view 不可用（`PLATFORM`），一个文件都不读 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 一批各算各的：某张看不了只有它那一项是失败条目 `{ path, error: { code, message } }`，path 照传入的原样，其余照常；全部失败时整个调用抛出第一个失败。错误码是通用的那一套：`VALIDATION`、`PERMISSION`、`NOT_FOUND`、`PLATFORM` | 测试 | `spec/acceptance.test.ts` |
| INV-7 | 作用域由空间注入、不由模型挑：路径怎么解析、能到哪儿、许不许看，全由 `ImageSpacePort.locate` 定——越出空间范围的（经符号链接指出去也算）那一张 `PERMISSION`，其余照常；读的是空间交回的真实文件，交给模型的写法也用空间给的 | 测试 | `spec/acceptance.test.ts` |
| INV-8 | 入参不合法由操作方法自己拦，不靠调用方：不是对象、files 不是数组、空批、超过 10 张、项不是带非空 path 的对象、region 不是四个有限数或宽高不是正数，一律 `VALIDATION`，整批一张都不看，不会半途崩 | 测试 | `spec/acceptance.test.ts` |
| INV-9 | 只看 PNG、JPEG、GIF、WebP，按文件头认、不看扩展名：PDF 报 `VALIDATION` 并说明文档不在这里看，文本与其他格式报 `VALIDATION` 并指向读文件的能力或先转换，头读不出来的算坏文件；目录与超过 20 MB 的文件同样只算那一张失败，太大的在读之前就拦下 | 测试 | `spec/acceptance.test.ts` |
| INV-10 | 取消信号在每张图之间核对：取消之后后面的图不再定位、不再交出，整个调用抛出取消原因 | 测试 | `spec/acceptance.test.ts` |
| INV-11 | 代码面的 `images` 命名空间是一条真路：模型写的程序照生成的 `baselines/code-surface/images.d.ts` 过 typecheck，在隔离里调到真实操作；图走代码面的图片通道、跟在结果旁边回去，程序拿到的只有尺寸（读像素的写法过不了 typecheck）；全部失败时程序接得住，看得见的就是 `error.code` 与 `error.message` | 测试 | `spec/acceptance.test.ts` |
| INV-12 | 代码模版（`template.js`）是一整份能照抄的程序，import 只写一次；它**整份照生成的真实声明过类型检查**，并且原样嵌在声明的模块头里。写错的模版会原样教出去，所以不许漂 | 测试 | `spec/acceptance.test.ts` |
| INV-13 | 模型面与常量表一致：声明里写的张数、长边、base64 体积上限都与 `ImageLimits` 对得上，带单位的数字一处都不漂；view 在模型面上只有一个入参，空间端口、调用上下文、缩图与交图的口子都不进模型面 | 测试 | `spec/acceptance.test.ts` |
| INV-14 | 分工与对外边界不塌：合同、类型、实现、工具函数各在其位，空间端口的每个方法都有操作在调；`./contracts` 入口整条引用链不碰 Node 内置模块，渲染进程可以直接加载 | 门禁 | `check:module-ownership` |
