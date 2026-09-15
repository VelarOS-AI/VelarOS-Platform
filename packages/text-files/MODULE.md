# @velaros-ai/text-files 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 先看 `src/impl/` 四个类上方的接口（`contract/provides.ts` 登记它们），utils 里每个函数上方有一句说明。
> 门禁：`bun run check:module-ownership`。

## 这是什么

磁盘上文本文件的无损读写：认编码、严格解码、按原编码无损写回、原子替换写入、有界读、流式读。
system 空间（`system:read`、`system:edit`、沙箱差量）与 project 空间（文件网关、事务的原字节与字节计划）读写文本都用这一份，两边对同一份字节的判定一致；改一次判定只改一处。
它不知道空间、不知道工具：报错用本包自己的码，各空间在边界上翻成自己的错误（project 翻成 `ProjectError`，system 翻成它的 `AppError` 码与说明）。

## 提供什么

**产品面**，登记在 `contract/provides.ts`：四件能力的 API 定义在各自类的上方，这里 re-export；对外的值都按接口标注类型：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `textCodec` | `TextCodecApi` | 认编码、严格解码、建按块解码器与流式识别器、按编码写成字节、按原字节保留编码、找孤立代理项、核对编码名 |
| （`textCodec.createProbe()` 造） | `TextEncodingProbeApi` | 一次流式编码识别：分块喂字节，喂完给结论 |
| （`textCodec.createDecoder(encoding)` 造） | `TextStreamDecoderApi` | 按块严格解码一段字节流，被块边界切开的字符不丢 |
| `textFileIo` | `TextFileIoApi` | 原子替换写字节、按原编码写文本、有界读、读文件头、流式读与整读正文、核对原字节 |
| `TextEncodings` | 契约常量 | 七种磁盘文本编码 |
| `TextFileErrorCodes` | 契约常量 | 本包的错误码，每个码一句含义 |

**数据面**是 `types/text-files.ts`，可移植：`TextEncoding`（编码名）、`DecodedText`（正文与编码）、`ExpectedBytes`（写前要核对的原字节）、`TextChunk`（流式读出的一块正文）。

两个入口对应 `package.json` 的 `exports`，源文件在 `src/exports/`，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `.` | Node 宿主 | 编解码、文件读写，外加它们用到的数据 |
| `./contracts` | 任何进程，含浏览器 | 常量表与可移植数据 |

没有注入面：本包不需要宿主塞任何东西。

## 骨干链路

| 能力 | 链路 |
| --- | --- |
| 认编码 | `textCodec.detect(bytes)` → `TextEncodingProbe`：四个严格的按块解码器（UTF-8、UTF-16LE、UTF-16BE、GB18030）跟着读，遇到非法字节的出局；读到末尾（不是 partial）再核对最后一个字符 → BOM → 文件头里 NUL 的奇偶分布认无 BOM 的 UTF-16（不到 16 字节只认 ASCII 与 NUL 交错）→ 读到过 NUL 算二进制 → 严格 UTF-8 → GB18030 → 都不是返回 null |
| 解码 | `textCodec.decode(bytes)` → 认编码 → 按编码的严格解码器解（BOM 不进正文）；认不出返回 null |
| 按块解码 | `textCodec.createDecoder(encoding)` → `TextStreamDecoder`：UTF-8、UTF-16 用 TextDecoder 的流式模式；GB18030 自己把末尾没凑齐的字节留到下一块、凑齐的整段一次解（Bun 的 TextDecoder 流式解 GB18030 会丢跨块的字）→ finish 时还有没凑齐的字节就抛错 |
| 写成字节 | `textCodec.encode(content, encoding)` → 找孤立代理项（有就抛 lossy）→ 按编码写、需要的补 BOM；GB18030 写完按 GB18030 读回来核对，对不上抛 lossy |
| 按原字节保留编码 | `textCodec.encodePreserving(original, before, after, encoding)` → 没改原样返回；不是 GB18030 等同 encode；GB18030 把原字节按字符对上 before 的下标 → 有界的字符级差异（算不出退回前后缀对齐）→ 没改的片段用原字节、改的重新编码 → 解码核对是 after |
| 原子写 | `textFileIo.writeBytes` / `writeText` → 核对权限位 → lstat，符号链接解到真正的文件 → 已有的只收单链接的普通文件 → 给了 expected 先核对磁盘字节 → 算出要写的字节（writeText 流式认已有文件的编码）→ 同目录 `open wx` 临时文件、精确设权限、写、fsync → 给了 expected 再核一次 → 改名 → fsync 目录 |
| 有界读 | `textFileIo.readBounded(path, max)` → 非阻塞只读打开、fstat 确认普通文件 → 大小超上限抛 tooLarge → 在同一句柄上读 size + 1 字节，多读到了抛 externalEdit |
| 流式读 | `textFileIo.readTextChunks(path, encoding?)` → 打开普通文件 → 没给编码就在同一句柄上流式认完整个文件 → 按块解码器一块一块解，每块带读到的字节位置，遇到非法字节抛 notText → 收尾核对 → 关句柄（提前结束也关） |
| 核对原字节 | `textFileIo.assertUnchanged(path, expected)` → 按预期长度有界读 → 多出字节、类型变了、内容不同都抛 externalEdit |

## 依赖什么

- 上游包：`@velaros-ai/core`（`AppError`、几个类型守卫）。
- `iconv-lite`（写 GB18030）、`diff`（按原字节保留编码时的字符级差异）。
- Node 内置模块：`node:fs`、`node:path`、`node:crypto`，只在根入口的引用链上；`./contracts` 整条引用链门禁核对不碰 Node 模块。
- 不读环境变量。

## 状态归谁

`textCodec`、`textFileIo` 只持有常量与编解码器引用，没有跨调用的状态。`TextEncodingProbe` 一次识别一份，状态（候选解码器、文件头缓冲、有没有见过 NUL）随识别结束丢弃；`TextStreamDecoder` 一段字节流一份，只留 GB18030 末尾没凑齐的几个字节。
文件句柄都在一次调用里开、在 finally 里关；原子写的临时文件在 finally 里删。

## 生命周期

没有需要释放的东西。`textCodec`、`textFileIo` 随进程存在；流式读的迭代器提前结束时同样关句柄。

## 失败语义

- 失败一律抛 `AppError`，`code` 是 `TextFileErrorCodes` 的码，`context` 带 path 与细节（lossy 带 offset 与 codeUnit，tooLarge 带 size 与 maxBytes）；调用方按码翻成自己的错误，文字已经是中文。
- 文件系统自己的 errno 错误（ENOENT、EACCES、EPERM 这类）原样抛出，不包。
- `decode`、`detect` 认不出返回 null，不抛错；`readBounded` 文件不存在返回 undefined。
- 写入失败时磁盘不动：编码失败、核对失败都发生在改名之前，临时文件一律删掉。

## 不变量

共 7 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排。
按检验方式：测试 6 条、门禁 1 条。未验证 0 条。

## 非目标

- 不管路径能不能碰：根内约束、敏感路径审批、拒读拒写名单都是空间自己的事，调用方给的路径已经判过。
- 不管换行：CRLF 适配、行号与偏移互换、文本匹配是各空间的编辑语义，两边不同，不合并。
- 不做编码转换的产品语义：project 的 recode 动作决定目标编码，本包只按给的编码写。
- 不猜单字节旧编码：Latin-1、Shift-JIS 这类不在七种之内，能按 GB18030 解开的当 GB18030，解不开的当二进制。

## 结构

```text
src/
  contract/     对外合同：provides.ts 登记三件能力的 API（定义在各自类上方，这里 re-export），constants.ts 是编码名表与错误码；没有注入面
  types/        只放类型：text-files.ts 是可移植数据
  impl/         一类一文件：TextFileIo（文件读写的唯一出口）→ TextCodec（编解码的唯一出口）→ TextEncodingProbe（一次流式识别）→ TextStreamDecoder（按块严格解码）
  utils/        encoding.ts（BOM、解码器标签、无 BOM 的 UTF-16、孤立代理项、写成字节、GB18030 的字符宽度、严格解码）、preserving.ts（GB18030 按原字节拼回）、file-io.ts（打开普通文件、有界读、读文件头、原子替换、核对原字节）、tuning.ts（可调参数）
  exports/      两个入口，只有转发
spec/           不变量登记与验收测试
test/           实现细节测试
```

**分层**（登记表 `layers`，上层可以引下层）：`TextFileIo.ts` → `TextCodec.ts` → `TextEncodingProbe.ts` → `TextStreamDecoder.ts`。

**类与接口。** 每个类实现一个接口，定义在类文件里、紧挨在类的上方并导出，在 `contract/provides.ts` 登记；类的公开方法只能是接口里的方法。整个进程只需要一份的，文件末尾给出那一份，按公开接口标注类型。

| 实现文件 | 接口 | 做什么 |
| --- | --- | --- |
| `TextFileIo.ts` | `TextFileIoApi`（同文件，provides 登记） | 文件读写：原子替换、按原编码写文本、有界读、读文件头、流式读、核对原字节；编解码交给注入的 `TextCodecApi` |
| `TextCodec.ts` | `TextCodecApi`（同文件，provides 登记） | 认编码、严格解码、写成字节、按原字节保留编码 |
| `TextEncodingProbe.ts` | `TextEncodingProbeApi`（同文件，provides 登记） | 一次流式编码识别，由 `textCodec.createProbe()` 造 |
| `TextStreamDecoder.ts` | `TextStreamDecoderApi`（同文件，provides 登记） | 按块严格解码一段字节流，由 `textCodec.createDecoder(encoding)` 造 |

**常量分四处。** 对外约定的编码名与错误码在 `contract/constants.ts`；可调的（文件头多大、流式每块多大、字符级差异的上限与超时）在 `utils/tuning.ts` 的 `TextFileTuning`；类里固定用的（候选编码、核对失败的说明）写成类的 `private static readonly`；编码判定的比例、GB18030 的字节宽度规则就地写在 utils 里，旁边一句说明。
