# @velaros-ai/path-rules 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 先看 `src/impl/` 三个类上方的接口（`contract/provides.ts` 登记它们），utils 里每个函数上方有一句说明。
> 门禁：`bun run check:module-ownership`。

## 这是什么

路径命中规则：glob 匹配、.gitignore 的解析与判定、遍历时要不要跳过某个条目、默认跳过的目录名。
system 空间（全局搜索、沙箱镜像）与 project 空间（列目录、搜索、拒读拒写与受保护文件的 glob）判定路径都用这一份，两边对同一条规则的结论一致；改一次判定只改一处。
它不知道空间、不知道工具，也不起子进程：要不要问 git、怎么起、超时多久由调用方注入执行口；路径能不能碰（根内约束、审批、拒读拒写）是各空间自己的事，本包只回答「这条路径命不命中这条规则」。

## 提供什么

**产品面**，登记在 `contract/provides.ts`：三件能力的 API 定义在各自类的上方，这里 re-export；对外的值都按接口标注类型：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `pathMatcher` | `PathMatcherApi` | glob 匹配：目录前缀、精确、picomatch 三种写法，大小写敏感可选 |
| `gitignoreRules` | `GitignoreRulesApi` | .gitignore 的解析、按目录读取与累积、按规则判定 |
| `createIgnorePolicy` | `IgnorePolicyApi` | 造一次遍历用的忽略判定：找规则根、攒规则、问 git、批量判 |
| `DiscoverySkippedDirectoryNames` | 契约常量 | 遍历与搜索默认跳过的 23 个目录名 |

**注入面**是 `contract/requires.ts` 的 `GitCheckIgnoreRunner`：批量问 git 哪些相对路径被忽略；拿不到 git 返回 null，本包按本地规则兜底。

**数据面**是 `types/path-rules.ts`，可移植：`GitignoreRule`（一条解析好的规则）、`PathMatchOptions`（区不区分大小写）、`IgnoreCandidate`（一个待判定的遍历条目）、`IgnoreRulesOrigin`（规则从哪一级算起）。`types/options.ts` 的 `IgnorePolicyOptions` 带注入口，只走根入口。

两个入口对应 `package.json` 的 `exports`，源文件是 `src` 根上的入口文件，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `.` | Node 宿主 | 三件能力、注入口，外加它们用到的数据 |
| `./contracts` | 任何进程，含浏览器 | 常量表与可移植数据 |

## 骨干链路

| 能力 | 链路 |
| --- | --- |
| glob 匹配 | `pathMatcher.matchesAny(path, patterns, options?)` → 规整路径 → 逐条规则：`/` 结尾按目录前缀 → `dir/**` 且 dir 无通配按目录前缀（连 dir 自己）→ 不含通配按精确或目录前缀 → 其余取（按 pattern 与大小写敏感与否缓存的）picomatch 匹配器 |
| 解析 .gitignore | `gitignoreRules.parse(content, baseRel)` → 逐行去 CR、去没转义的尾随空格 → 注释与 `!` 判在还原转义之前 → 还原 `\ `、`\#`、`\!` → 末尾 `/` 记成 directoryOnly → 锚定（`/` 开头或中间有 `/`）只展开一条，其余展开「本级」与「任意层级」两条，都接上所在目录 |
| 判一条路径 | `gitignoreRules.isIgnored(rel, rules, isDirectory)` → 算出各级上级目录 → 逐条规则：规则命中（directoryOnly 的只认目录）或某级上级命中 → 最后一条命中的说了算，反向规则把它捞回来 |
| 遍历判一批 | `createIgnorePolicy(root, options)` → 首次判定前定规则根（`repository` 时往上找版本库根，找不到或根自己被忽略就整次不跳）→ 滤掉规则根自己与根外的条目 → 有执行口先问 git（一批一次；返回 null 就记下不再问）→ 否则按「从规则根到父目录逐级累积」的规则判，每个目录只读一次 |

## 依赖什么

- 上游包：`@velaros-ai/core`（几个类型守卫）、`@velaros-ai/platform`（`currentPlatform` 的路径文本包含判定：算相对规则根的路径、判在不在根里）。
- `picomatch`（glob 编译）。
- Node 内置模块：`node:fs/promises`、`node:path`，只在根入口的引用链上；`./contracts` 整条引用链门禁核对不碰 Node 模块。
- 不读环境变量，不起子进程——要问 git 时用调用方注入的执行口。

## 状态归谁

`pathMatcher` 持有编译好的匹配器缓存（LRU，容量见 `PathRulesTuning.glob.matcherCacheEntries`），是纯函数的加速，没有跨调用的语义。`gitignoreRules` 只持有一个匹配器引用，不留状态——读到的规则由调用方自己攒。
`IgnorePolicy` 一次遍历一份：规则根、每个目录累积到它为止的规则、git 还能不能用都记在实例里，遍历结束一起丢。没有模块级可变状态。

## 生命周期

没有需要释放的东西。`pathMatcher`、`gitignoreRules` 随进程存在；忽略策略随一次遍历建、随它丢。

## 失败语义

- 本包不抛自己的错误：`.gitignore` 读不了当作没有规则，规则根之外或规则根自己的条目一律不跳。
- 注入的 git 执行口返回 null（git 不在、跑不起来、退出码异常）时回退到本地规则，并且这一次遍历之后不再问 git；执行口自己抛出的错误原样透出，由调用方决定怎么办。
- `picomatch` 对写坏的 pattern 抛出的错误原样透出（写规则的是宿主或模型，静默吞掉会让「规则没生效」查不出来）。

## 不变量

共 7 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排。
按检验方式：测试 6 条、门禁 1 条。未验证 0 条。

## 非目标

- 不管路径能不能碰：根内约束、拒读拒写名单、敏感路径审批、真实路径解析都是空间自己的事（真实路径在 `@velaros-ai/core/utils/RealPath`，路径文本的包含判定在 `@velaros-ai/platform`）。
- 不起子进程：问 git 的执行口由调用方注入，超时、并发、日志按各空间自己的规矩来。
- 不替 git 做工作树语义：暂存区、`.git/info/exclude`、全局 `core.excludesFile` 只有 git 自己认得，需要完整语义就注入执行口让 git 回答。
- 不管遍历本身：读目录、深度、排序、上限在各空间的搜索与列举里，本包只回答某个条目要不要跳过。

## 结构

```text
src/
  contract/     对外合同：provides.ts 登记三件能力的 API（定义在各自类上方，这里 re-export），requires.ts 是问 git 的执行口，constants.ts 是默认跳过的目录名表
  types/        只放类型：path-rules.ts 是可移植数据，options.ts 是带注入口的选项
  impl/         一类一文件：IgnorePolicy（一次遍历的忽略判定）→ GitignoreRules（.gitignore 的解析与判定）→ PathMatcher（glob 匹配）
  utils/        path.ts（相对路径的规整、在不在根里、各级上级）、glob.ts（规则形状）、gitignore.ts（一行的规整与展开）、discovery.ts（找版本库根、读 .gitignore）、tuning.ts（可调参数）
  index.ts      `.` 入口，只转发
  contracts.ts  `./contracts` 入口，只转发
spec/           不变量登记与验收测试
test/           实现细节测试
```

**分层**（登记表 `layers`，上层可以引下层）：`IgnorePolicy.ts` → `GitignoreRules.ts` → `PathMatcher.ts`。

**类与接口。** 每个类实现一个接口，定义在类文件里、紧挨在类的上方并导出，在 `contract/provides.ts` 登记；类的公开方法只能是接口里的方法。整个进程只需要一份的，文件末尾给出那一份，按公开接口标注类型；一次遍历一份的由工厂函数造。

| 实现文件 | 接口 | 做什么 |
| --- | --- | --- |
| `IgnorePolicy.ts` | `IgnorePolicyApi`（同文件，provides 登记） | 一次遍历的忽略判定，由 `createIgnorePolicy` 造；规则判定交给注入的 `GitignoreRulesApi` |
| `GitignoreRules.ts` | `GitignoreRulesApi`（同文件，provides 登记） | .gitignore 的解析、读取与判定；命中判断交给注入的 `PathMatcherApi` |
| `PathMatcher.ts` | `PathMatcherApi`（同文件，provides 登记） | glob 匹配与编译缓存 |

**常量分四处。** 对外约定的目录名表在 `contract/constants.ts`；可调的（匹配器缓存多少条）在 `utils/tuning.ts` 的 `PathRulesTuning`；规则展开与路径规整的正则就地写在 utils 里，旁边一句说明。
