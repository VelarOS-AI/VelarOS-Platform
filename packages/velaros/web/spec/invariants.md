# 网上查资料不变量登记

每一条都是本单元对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；新增一条同样要点名。
检验方式与 `packages/agent/spec/invariants.md` 相同：测试 / 类型 / 门禁 / 运行时 / 文字，`check:module-ownership` 核对每一行的检验器是否存在。编号只增不重排。

浏览器是宿主给的（不显示的页面），验收测试用 `spec/support.ts` 的假无头浏览器与假钟；页面脚本在真浏览器里认不认得出结果、删不删得对东西，
禁了脚本的页面读不读得出，由 `test/probes/electron-web.probe.mjs` 在真的 Electron 里核对（本地夹具页加真搜索、真读），bun test 不跑它，所以这几条记成文字档。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | search 按宿主报的用户搜索引擎先搜：结果页地址按搜索引擎拼好（Bing 带上要几条的 `count`），交回 `{ query, engine, results }`，query 是去掉首尾空白后的搜索词，engine 是实际搜成的那个；每次尝试开一个页面、用完关掉 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 结果的地址是真实目标：Bing 的 `bing.com/ck/a` 跳转链接把 u 参数去掉「a1」再按 base64url 解开，Google 的 `/url?q=`（或 `url=`）取参数里的地址；解不出 http(s) 地址的、搜索引擎自己的页面（再搜一次、图片、跳转）都丢掉；按地址去重（只差 # 那段的算同一个，留第一条），最多 limit 条（缺省 `WebLimits.defaultResults`、最多 `WebLimits.maxResults`）；标题空着用地址顶上 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | Google 搜不通就换 Bing，engine 如实写 bing：宿主报加载出错、到 `WebTuning.search.googleCommitMs` 连一个文档都没落下（打不开时连接一直挂着，不等加载时限）、到加载时限还没加载完又没认出结果、被拦成验证页或同意页（地址在 `/sorry/` 下、`consent.google.com`；没认出结果时正文开头有 unusual traffic、异常流量这类字样）、结果页里认不出一条结果，都算搜不通。文档落下了只是结果页加载得慢的，不被落下时限掐掉，到加载时限照抓已经出来的结果。Google 认出了结果就不碰 Bing，正常结果里碰巧有那些字样也不算被拦 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 记住 Google 搜不通：之后 `WebTuning.search.googleBackoffMs`（12 小时）以内的搜索直接走 Bing，一个 Google 页面都不开；过了这段时间再试 Google，搜通了就忘掉。宿主给了退避记忆（`WebEngineBackoff`）就跨重启：每次搜索读一次，进程里记着的与它存着的取晚的；只在记下一次搜不通时写（退避到什么时候）；读写抛错只记一笔，照进程里的来。用户选 Bing 时先搜 Bing，搜不通才试 Google（Google 在退避里就不试） | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 两个搜索引擎都搜不了抛 `WEB_SEARCH_FAILED`，message 写着搜的是什么、两边各自为什么没成；搜索引擎明说没有结果（Bing 的 `.b_no`）不算失败，交回空的 results | 测试 | `spec/acceptance.test.ts` |
| INV-6 | read 在页面加载完之后先等渲染：readyState 是 complete、正文长度 `WebTuning.read.stableMs` 不变、宿主报的主框架也没在加载（`WebPage.loading`，加载完之后页面自己又跳走的那种）才读，最多等 `WebTuning.read.settleMs`；等的时候看不到页面（正在跳走、脚本出错）只当还没稳。到点还在加载的不等渲染，已经出来的正文照读 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | read 交回的网页正文收拾过：换行统一成 `\n`，行内连续空白并成一个空格、行首尾不留空白，段落之间正好空一行；url 是跳转之后的最终地址，title 是网页标题。纯文本文件不这样收拾，见 INV-20 | 测试 | `spec/acceptance.test.ts` |
| INV-8 | read 按字符切段：text 是整页正文从 offset 起最多 maxChars 个字符（缺省 `WebLimits.defaultReadChars`、最多 `WebLimits.maxReadChars`），切口不劈开代理对、每段至少前进一个字；totalChars 是整页正文的字符数，nextOffset 读到头是 null，offset 超出全文交回空 text | 测试 | `spec/acceptance.test.ts` |
| INV-9 | 网页打不开抛 `WEB_PAGE_UNREACHABLE`（宿主报加载出错；到点还什么都没加载出来）；打开的是 PDF、读正文的脚本没跑成（出错或超时）抛 `WEB_PAGE_UNREADABLE`；message 都带网址与原因 | 测试 | `spec/acceptance.test.ts` |
| INV-10 | 页面一定关：开出来的每一页都关掉，搜成、搜不通、打不开、脚本出错、超时、取消都一样；撒手之后宿主才开出来的页面也关掉。开页面、装地址、跑脚本都有时限，到点就撒手，不陪宿主一直等；到点连一个文档都没落下的页面不再往里跑脚本（宿主对它跑脚本会一直卡着） | 测试 | `spec/acceptance.test.ts` |
| INV-11 | 取消：调用之前就取消的一页都不开；中途取消不等页面，立刻以取消原因失败，搜索不再试下一个搜索引擎，开着的页面照关 | 测试 | `spec/acceptance.test.ts` |
| INV-12 | 入参由操作自己核对，不靠调用方：不是对象、多给字段、query 空或超长、limit 不是 1 到上限的整数、url 不是 http(s) 网址（没写协议补 https://）、offset 不是不小于 0 的整数、maxChars 不是 1 到上限的整数，一律 `VALIDATION`，一个页面都不开 | 测试 | `spec/acceptance.test.ts` |
| INV-13 | 代码面的 `web` 命名空间是一条真路：模型写的程序 import 生成的 `baselines/script/web.d.ts` 里的操作、过语法检查，在隔离里调到真实操作；失败时程序接得住，看得见的就是 `error.code` 与 `error.message` | 测试 | `spec/acceptance.test.ts` |
| INV-14 | 代码模版（`template.js`）是日常用法的示例程序（只是示例，模型按需要改写），import 只写一次；它整份照生成的真实声明过类型检查，不嵌进声明，随模型面发布、按需读；每个函数照写法在假浏览器里跑通由 `test/template.test.ts` 核对 | 测试 | `spec/acceptance.test.ts` |
| INV-15 | 模型面与常量表一致：声明里写的条数、字符数都是 `WebLimits` 里的数；两个操作都声明为没有效果（none）、各只有一个入参；端口、页面、调用上下文与钟都不进模型面 | 测试 | `spec/acceptance.test.ts` |
| INV-16 | 分工与对外边界不塌：合同、类型、实现、工具函数各在其位，空间端口的每个方法都有操作在调；数字都在常量表或可调参数表里；`./contracts` 入口整条引用链不碰 Node 内置模块 | 门禁 | `check:module-ownership` |
| INV-17 | 页面脚本在真浏览器里做对：Bing、Google 结果页认得出结果与摘要（去掉摘要前的小标签），读正文时删掉脚本、导航、页眉页脚、侧栏与表单却不删包着大半正文的块，article、main 占大半时只读它；真搜一次中文、一次英文都有结果，Google 的 `/goto` 链接经宿主换成真实地址；发往 Google 的请求一律卡住时，从开始搜到开始装 Bing 的结果页不超过 6 秒，之后的搜索一个 Google 请求都不发，退避记在宿主的 JSON 文件里 | 文字 | |
| INV-18 | Google 的 `/goto?url=…` 跳转链接（令牌本地解不开）：宿主给了 `resolveRedirect` 就一批并发各问一次、共用 `WebTuning.search.redirectTimeoutMs` 的时限，换成它跳去的 http(s) 地址之后再去重、截条数；只问要的条数外加 `WebTuning.search.spareHits` 条原始结果里的；宿主没给这个口子、问出错、到点没回、回的不是 http(s) 地址的原样留着（read 照样读得了） | 测试 | `spec/acceptance.test.ts` |
| INV-19 | 结果一出现在 DOM 里就抓，不等整页（图片、脚本）加载完：文档落下之后每 `WebTuning.search.resultsPollMs` 看一眼结果页，认出了结果、并且 DOM 已经解析完（readyState 不是 loading）或条数稳住 `WebTuning.search.resultsSteadyMs`，就用这一眼并叫停剩下的加载；一条结果都没有时不提前下结论，照旧等页面真加载完或到加载时限再看；加载完之后页面又自己跳走的（宿主报 `WebPage.loading`），接着看跳过去的那一页，直到加载时限；落在验证页、同意页上的当场认成被拦、换下一个搜索引擎；落下时限、加载时限、验证页的认法都照旧；Google 与 Bing 都这样。要快起来，宿主的 `evaluate` 得当场跑（Electron 用 `mainFrame.executeJavaScript`） | 测试 | `spec/acceptance.test.ts` |
| INV-20 | read 读纯文本文件（文档的媒体类型是 text/ 下除 HTML、XML 之外的，或 JSON、JavaScript：源码、Markdown、YAML 这类）时正文原样交回：缩进、行内空白、制表符、行尾空白、连着的空行都留着，只把换行统一成 `\n`、去掉开头的空行与末尾的空白；网页照 INV-7 收拾，切段照 INV-8 | 测试 | `spec/acceptance.test.ts` |
| INV-21 | 页面禁了脚本（响应头 CSP 带 sandbox、没给 allow-scripts，比如 raw.githubusercontent.com 上的文件）照样读得出：本单元读页面不靠页面自己的脚本，宿主按 `WebPage.evaluate` 的约定在这种页上也跑得了（Electron 遇 `'Script not run'` 改经 DevTools 协议的 `Runtime.evaluate`）；读出来的纯文本文件照 INV-20 原样、网页照常删导航页脚只读正文 | 文字 | |
