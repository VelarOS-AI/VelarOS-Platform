# `@velaros-ai/core` 按仓库标准改造方案

> 对象：`packages/core`（0.4.2，core 域，零依赖、无领域语义），HEAD `606fba59`（含刚落地的 `utils/RealPath`；数据采于 `7c39d5c9`，其后本包只有 `0ac2b5f1` 把 `RealPath.ts` 的判空改成 `isNotNull`/`isEmpty`，结论不变）。本包工作区干净；agent 的整文件搬家正在进行（工作区 500 多个未提交文件，其中 agent 有 231 个文件 import core），这决定了本包破坏性部分的执行时机（§6）。
> 标准：`docs/architecture/module-ownership.md`、ADR 0007/0008、门禁与登记表；准入规矩 `packages/core/README.md`（零依赖、无领域语义、至少被两个不相邻领域复用）与 `check:core-semantic-vocabulary`。流水账里已定的不再论证：公共件单独成域不进 core；真实路径进 core（已落地）；路径文本包含判断进 platform（已落地）。
> 消费方：AST 扫描 Platform 全仓与 Desktop、Workbench、Termel（Extension、Cloud、Website 不用 core）。基线：`bun test test` 9 pass / 0 fail（4 个文件）。复现脚本在草稿区 `plan-small/tools/core-probe.ts`。

## 0. 结论先行

1. **规模**：`src/` 24 个源文件 2,428 行；6 个入口，其中 `./utils/*` 是通配子路径（11 个文件都能按文件名 import）；根入口导出 53 个符号，各入口合计约 140 个（含重名重复）。**1,455 个文件 import core**：Platform 656（其中 297 个走子路径）、Desktop 628（354）、Workbench 161（79）、Termel 10（5）。
2. **core 是全仓唯一「产品就是一套函数」的包，按现行门禁有四处过不去**：utils 的函数不许出包（core 出的正是 `isString`、`toNullable` 这类函数）；类不许出包（`AppError` 被 `new` 了 1,871 次、`instanceof` 48 次、静态方法 498 次）；`Result` 类型与同名值不能分放在 types 与 impl 再从一个入口一起导出（TS 报重复标识符，已在草稿区验证）；通配子路径与「exports 与入口文件一一对应」冲突。
3. **推荐**：给门禁加一个只给 core 用的「原语包」档——登记表新增 `publicUtils`（这些 utils 文件里带中文说明的函数就是产品面，可以从入口转发）与 `publicClasses: ['AppError']`；其余照标准：有状态的日志运行时、计时作用域做成类加类上方接口，出实例或工厂；常量进合同表；数据类型进可移植文件。备选是不改门禁、把每组函数包成「无状态类 + 实例 + 逐名别名」，代码量约三倍、且等于在门禁上开一个能被别的包滥用的口子（§7-1）。
4. **入口收成三个**：`.`（浏览器安全，全部通用原语、`AppError`、`results`、`Log`、`timerScopes`）、`./contracts`（错误码表、日志级别与可移植数据）、`./node`（Node 专用：原子写、真实路径）。`./assert`、`./error`、`./logger`、`./result`、`./utils/*` 全部并入。
5. **死代码**：`./assert` 整个入口（3 个函数零调用）；`unknownJsonRecord` 的 `readRecord`、`readStringPreserveOuterWhitespace`、`peekLooseString`、`peekLooseBoolean`（只有 ui 自己的副本在用）；日志的 `LogError`、`LogAssertionError`、`check/ensure/fail/withContext`、`pause/resume/setLevel/hasTransport/listTransports/init`；`writeFileAtomicallySync`；`TimerScope` 的 `host` 注入（零使用的测试钩子）；守卫品牌的 4 个导出。
6. **新增原语**（跨包重复、域无关、满足准入）：`readErrnoCode`（10 个包至少 11 处各写一份）、代理对安全的截断（修 `truncate` 本身，另出 `clampToCodePointBoundary`、`takeTail`）、`stableStringify`（agent 3 份、agent-lab 3 份、browser 2 份）、错误码表补 `UNAVAILABLE`（development 与 project 已按这个码约定降级）。**错误信封（`reason`/`details`/`suggestedNextAction`）不进 core**：它是 agent 工具失败的语义，去 `@velaros-ai/agent/tool-contract`（§3.6）。
7. **真 bug**：`truncate` 与 `AppError.getMessage` 的截断都会切开代理对，产生孤立代理项（已复现）；`LogRuntime.pause()` 无上限缓冲；两处小问题见 §5。
8. **节奏**：先做「只增不删」的部分（新原语、修 bug、改文字，0.4.x 补丁）；破坏性部分（收入口、删死码、`Log`/`results`/`timerScopes` 改名）等 agent、browser、memory、kernel 的搬家落地后一次做，配一个一次性 codemod，Platform 约 300 个文件机械改写，产品侧给迁移表，core 升 0.5.0。

## 1. 现状

### 1.1 入口、导出与消费方

| 入口 | 导出 | 被用 | 引用它的文件 | 备注 |
| --- | ---: | ---: | --- | --- |
| `.` | 53 | 42 | Platform 577、Desktop 503、Workbench 124、Termel 8 | 零使用：`assertInvariant`、`assertPresent`、`required`、守卫品牌 4 个、`ErrorCode`/`ErrorContext`/`SerializedError`/`AppErrorOptions`（类型都从 `./error` 取） |
| `./error` | 5 | 4 | 560 | `AppError` 547 处；`AppErrorOptions` 零使用 |
| `./logger` | 24 | 10 | 104 | 在用：`logRuntime`（与根的 `Log` 是同一个实例）、`ScopedLog`、`Logger`（当类型）、`LoggerFactory`（2）、`createCallbackTransport`（2）、`createMemoryTransport`（1）、`LogRecord/LogLevel/LogTransport` |
| `./result` | 1 | 1 | 83 | `Result`，产品侧约 190 处调用（Desktop 102、Workbench 88） |
| `./assert` | 3 | 0 | 0 | 整个入口没人用 |
| `./utils/TimerScope` | 8 | 2 | 104 | `new TimerScope(` 88 处、`TimerScope.sleep(` 29 处、`TimerLease` 36 处 |
| `./utils/unknownJsonRecord` | 20 | 15 | 52 | Desktop 渲染层还 `export *` 了一份（没人经它 import） |
| `./utils/FilePersistence` | 9 | 5 | 26 | Desktop 19、Workbench 4、agent/kernel/system 各 1 |
| `./utils/RealPath` | 1 | 0 | 0 | 刚落地，调用方迁移随 text-files 之后做 |
| `./utils/{array,json,mapDefined,nullish,number,optionalWhen,string}` | — | — | Platform 26、Desktop 2 | 与根入口重复的名字（`clampRounded` 只在 `./utils/number`） |

### 1.2 结构

| 文件 | 行 | 内容 |
| --- | ---: | --- |
| `typeGuards.ts` | 186 | 23 个守卫、`TypeGuards` 命名空间、给每个守卫打 `Symbol.for` 品牌的模块级循环（`optionalWhen` 靠品牌认守卫，跨模块副本也成立） |
| `error.ts` | 240 | `AppError`：码、消息、cause、context；`from`（沿 error/cause/lastError/errors 链取码与消息）、`getMessage`（取不到就脱敏后 JSON 化并截到 1,000）、`fromJSON`、`toJSON`、跨副本的 `Symbol.hasInstance` |
| `result.ts` | 60 | `Result<T>` 类型 + 同名的 `Result` 值（`ok/fail/unwrap/match/wrap/wrapSync`） |
| `assert.ts` | 31 | 三个断言，零使用 |
| `logger/` | 8 / 881 | `LogRuntime`（全局单例，实现 `GlobalLog`）、`Logger`（实现 `ScopedLog`）、两个错误类同一文件、格式化与环境探测、两个 transport 工厂；控制台流故障状态是模块级 `WeakMap` |
| `utils/TimerScope.ts` | 490 | 生命周期作用域：延迟、间隔、下一帧、sleep、超时、防抖、子作用域；可注入 `TimerHost` |
| `utils/FilePersistence.ts` | 137 | 同目录临时文件 + rename 的原子写（文本/JSON，同步与异步），用 `logRuntime` 记清理失败 |
| `utils/RealPath.ts` | 36 | `resolveRealPath`（追悬空链接，最多 40 跳） |
| `utils/unknownJsonRecord.ts` | 143 | 未知 JSON 的收窄与读字段（20 个导出，含 4 个别名式重导出） |
| 其余 7 个 utils | 208 | 数组、JSON、nullish、数字、条件取值、字符串 |

### 1.3 与标准的冲突点

| 规矩 | core 现状 |
| --- | --- |
| 导出的值只能是常量表或 impl 里按接口标注的实例/工厂；utils 函数、类不出包 | 产品面几乎全是函数；`AppError`、`TimerScope`、`LogRuntime`、`Logger`、`LogError` 类出包 |
| exports 与 `src/exports/` 文件一一对应 | `./utils/*` 通配 |
| 一类一文件、类实现类上方接口、无公开静态成员 | `logger/errors.ts` 两个类；`TimerScope` 无接口且有静态 `sleep`；`LogRuntime` 公开了接口外的 `init`、`writeMessage`、`writeEvent`、`createAssertionError`、`createFailureError` |
| 模块级只放日志与导出的实例 | `consoleStreamStates` WeakMap、守卫品牌循环、`OptionalWhenTypeGuardNames` |
| 数字缺省进 tuning | memory transport 500 条、错误字符串化 1,000 字符、JSON 缩进 2 |
| 门禁把 `Log.tag(` 认作「模块级日志」 | 仓内另有 141 处用 `logRuntime`（同一个实例的别名），已治理的包里写 `logRuntime.tag` 会被门禁判成模块级常量 |
| 报错中文 | `optionalWhen` 的 TypeError、重复 transport 的报错是英文 |

### 1.4 测试

4 个文件 9 条：边界（不许出现领域文件）、控制台管道关闭不崩、未知 JSON 读字段、真实路径。`AppError`（跨副本 instanceof、取码、脱敏截断）、`Result`、`TimerScope`（490 行）、`optionalWhen` 品牌、原子写都没有测试。

## 2. 目标布局

### 2.1 「原语包」档（门禁与标准的改动，只给 core）

- 登记表字段 `publicUtils: [...]`：列出的 utils 文件里导出的函数就是产品面，可以从入口逐名转发。门禁照查：每个函数上方一句中文说明（现有规则）；签名用到的类型必须来自 types 或合同并从入口导出（把这些函数签名加进公开面的根）；文件本身仍只放函数与常量、只引 utils/types/合同。
- 登记表字段 `publicClasses: ['AppError']`：唯一允许出包的类。它的公开成员签名同样进公开面的根。理由：它是全仓共用的错误货币，`instanceof`（含跨模块副本）本身就是契约。
- `module-ownership.md` 加一段「原语包（只有 core）」，写明为什么例外、例外到哪为止。

### 2.2 目录

```text
src/
  contract/   provides.ts、requires.ts、constants.ts
  types/      core.ts（可移植：错误码、SerializedError、Result<T>、日志级别与日志记录、LogRuntimeOptions）
              options.ts（计时任务选项、防抖回调、原子写选项等带函数或 Node 类型的选项）
  impl/       AppError.ts、LogRuntime.ts、ScopedLogger.ts、MemoryTransport.ts、TimerScope.ts、TimerScopes.ts、ResultOperations.ts
  utils/      guards.ts、nullish.ts、collections.ts、text.ts、numbers.ts、records.ts、errors.ts、    ← publicUtils（浏览器安全）
              atomic-files.ts、real-path.ts、                                             ← publicUtils（Node，只经 ./node）
              log-format.ts、timers.ts、tuning.ts                                           ← 包内
  exports/    index.ts、contracts.ts、node.ts
```

### 2.3 逐文件去处

| 现有 | 去处 |
| --- | --- |
| `typeGuards.ts` | `utils/guards.ts`：每个守卫用 `defineGuard(名字, 谓词)` 定义，品牌在定义时打上，不再有模块级循环；品牌符号与守卫名单是规则数据，留在本文件不出包；`TypeGuards` 命名空间不再导出 |
| `utils/optionalWhen.ts`、`nullish.ts`、`mapDefined.ts` | `utils/nullish.ts`（`toNullable`、`toOptional`、`mapDefined`、`optionalWhen`、`optionalWhenLazy`）；`optionalWhen` 重载用到的 5 个类型别名移到 `types/options.ts`，其中「已登记守卫」改由手写的 `KnownTypeGuards` 名字到签名的映射派生（types 不许 `typeof` utils 里的值），名单与 `guards.ts` 的一致由验收用例核对 |
| `utils/array.ts` | `utils/collections.ts` |
| `utils/string.ts`、`json.ts` | `utils/text.ts`：`isBlank`、`truncate`（改成不切代理对）、新增 `clampToCodePointBoundary`、`takeTail`、`stableStringify`；`stringifyPretty` |
| `utils/number.ts` | `utils/numbers.ts`（`clamp`、`clampRounded`） |
| `utils/unknownJsonRecord.ts` | `utils/records.ts`，删 4 个别名与 2 个守卫重导出 |
| `error.ts` | `impl/AppError.ts`（类，公开面不变）；私有静态方法（取码、取消息、脱敏、截断、识别序列化错误）是无状态的，移到 `utils/errors.ts`；`ErrorCode` 等类型进 `types/core.ts`；新增 `readErrnoCode` 在 `utils/errors.ts` |
| `result.ts` | 类型 `Result<T>` 进 `types/core.ts`；值改成 `impl/ResultOperations.ts` 的实例 `results`（`ResultApi`）——同名值与类型不能分两处出包（§7-2） |
| `assert.ts` | 删除 |
| `logger/runtime.ts`、`manager.ts` | `impl/LogRuntime.ts`（实现 `GlobalLogApi`，文件末尾 `export const Log: GlobalLogApi`；控制台流故障状态改为实例字段；给 `ScopedLogger` 用的写入口是同文件的配套接口 `LogRuntimeSink`） |
| `logger/Logger.ts` | `impl/ScopedLogger.ts`（实现 `ScopedLogApi`） |
| `logger/transports.ts` | `impl/MemoryTransport.ts`（类名与工厂名保留 `MemoryTransport` 字样，词汇门的豁免正则认得它）；`createCallbackTransport` 删除，宿主直接写一个满足 `LogTransport` 的对象 |
| `logger/errors.ts` | 删除（只被 `check/ensure/fail` 用）；重复 transport 改抛 `AppError(INVARIANT, 中文)` |
| `logger/helpers.ts`、`types.ts` | `utils/log-format.ts`（级别映射、颜色、环境探测、合并上下文、控制台载荷）；类型进 `types/` 与合同 |
| `utils/TimerScope.ts` | `impl/TimerScope.ts`（类上方 `TimerScopeApi`）+ `impl/TimerScopes.ts`（`TimerScopesApi`：`create(options)`、`sleep(ms, options)`，实例 `timerScopes`，取代 `new TimerScope` 与静态 `sleep`）；辅助函数进 `utils/timers.ts`；删 `host` 注入 |
| `utils/FilePersistence.ts` | `utils/atomic-files.ts`（经 `./node`）；清理失败不再记日志（utils 不能引 impl 的 `Log`），临时文件清理失败按注释说明吞掉、原错误照抛 |
| `utils/RealPath.ts` | `utils/real-path.ts`（经 `./node`）；模块级的 `MaxDanglingLinkHops = 40` 改成循环里就地写加一句说明（门禁不许 utils 有模块级数字常量，「符号链接最多跳几次」按标准属于就地写的算法数字，system 的同一段就是这么写的） |
| `index.ts`、`logger/index.ts` | `exports/index.ts`、`contracts.ts`、`node.ts`，逐名转发 |

### 2.4 分层与登记表

分层：`[ResultOperations, TimerScopes] → [TimerScope, LogRuntime, ScopedLogger, MemoryTransport] → [AppError]`（`LogRuntime` 与 `ScopedLogger` 互相引用接口，放同一层）。登记表：`portable: 'core.ts'`，`tuning: 'tuning.ts'`，`browserSafeEntries: ['index.ts', 'contracts.ts']`，`publicUtils`、`publicClasses` 如 §2.1；不读 `VELAROS_*` 变量（`NODE_ENV` 与 `import.meta.env.MODE` 只用来猜日志环境，门禁的变量表只认 `VELAROS_*`，不登记）。

## 3. 合同草案

### 3.1 provides（类上方接口）

| 接口 | 出包的值 | 成员 |
| --- | --- | --- |
| `GlobalLogApi` | `Log` | `configure`、`tag`、`addTransport`、`tryAddTransport`、`removeTransport`、`flush`、`dispose`（删 `setLevel`、`pause`、`resume`、`event`、`hasTransport`、`listTransports`，都零调用；`pause` 的缓冲没有上限） |
| `ScopedLogApi` | 经 `Log.tag()` 取得 | `scope`、`child`、七个级别、`caught`、`event`（删 `withContext`、`check`、`ensure`、`fail`） |
| `MemoryTransportApi` | 工厂 `createMemoryTransport(options)` | `LogTransport` + `records`、`clear` |
| `TimerScopeApi`、`TimerScopesApi` | `timerScopes` | 作用域：`after`、`every`、`nextFrame`、`sleep`、`withTimeout`、`debounce`、`cancel`、`cancelAll`、`child`、`dispose`、`isDisposed`、`size`；工厂：`create`、`sleep`。`child`、`cancelAll`、`size` 按名字扫是零调用，执行时再核一遍再决定删不删 |
| `TimerLease`、`DebouncedTimerCallback` | 经上面取得 | 没有类的公开接口，直接声明在 provides |
| `ResultApi` | `results` | `ok`、`fail`、`unwrap`、`match`、`wrap`、`wrapSync` |

### 3.2 requires

`LogTransport`：宿主往 `Log` 里挂的输出（Desktop 的文件日志、调试桥、通知）。只此一个注入点。

### 3.3 constants

| 表 | 内容 |
| --- | --- |
| `CoreErrorCodes` | `UNKNOWN`、`NETWORK`、`IPC`、`PERMISSION`、`PLATFORM`、`VALIDATION`、`NOT_FOUND`、`TIMEOUT`、`ASSERTION`、`INVARIANT`，**新增 `UNAVAILABLE`**（能力暂不可用、调用方应降级；development 与 project 已在用这个字面量）；删 `LOG_FAILURE`、`LOG_ASSERTION`。`ErrorCode = CoreErrorCode \| (string & {})`，各领域另立自己的码表 |
| `LogLevels` | `trace`…`fatal` 七级，从低到高 |

可调参数 `CoreTuning`：内存 transport 缺省保留 500 条、错误对象字符串化上限 1,000 字符、错误链最多追 5 层。

### 3.4 原语面（`publicUtils`）清单

| 文件 | 出包的函数 |
| --- | --- |
| `guards.ts` | `isNull`、`isNotNull`、`isUndefined`、`isNotUndefined`、`isPresent`、`isBoolean`、`isTrue`、`isFalse`、`isString`、`isNonBlankString`、`isNumber`、`isPositiveNumber`、`isFiniteNumber`、`isFunction`、`isBigInt`、`isSymbol`、`isObject`、`isRecord`、`isPlainObject`、`isArray`、`isNonEmptyArray`、`numberOrNull`、`trimmedStringOrEmpty` |
| `nullish.ts` | `toNullable`、`toOptional`、`mapDefined`、`optionalWhen`、`optionalWhenLazy` |
| `collections.ts` | `isEmpty`、`first`、`last`、`unique`、`compact`、`sum` |
| `text.ts` | `isBlank`、`truncate`、`clampToCodePointBoundary`（新）、`takeTail`（新）、`stableStringify`（新）、`stringifyPretty` |
| `numbers.ts` | `clamp`、`clampRounded` |
| `records.ts` | `asRecord`、`readString`、`readRawString`、`readStringScalar`、`readRawStringScalar`、`readFirstString`、`readNumber`、`readNumberScalar`、`readBoolean`、`readBooleanScalar`、`readStringArray`、`normalizeUnknownStringArray`、`readRecordsArray` |
| `errors.ts` | `readErrnoCode`（新） |
| `atomic-files.ts`（`./node`） | `writeFileAtomically`、`writeTextFileAtomically`、`writeTextFileAtomicallySync`、`writeJsonFileAtomically`、`writeJsonFileAtomicallySync` |
| `real-path.ts`（`./node`） | `resolveRealPath` |

### 3.5 要删的导出与替代（core 0.5.0 迁移表）

| 现在 | 以后 | 影响面 |
| --- | --- | --- |
| `from '@velaros-ai/core/error'`、`/logger`、`/result`、`/utils/{TimerScope,unknownJsonRecord,array,json,mapDefined,nullish,number,optionalWhen,string}` | `from '@velaros-ai/core'` | Platform 约 300 个文件、产品约 440 个文件，只改说明符 |
| `from '@velaros-ai/core/utils/FilePersistence'`、`/utils/RealPath` | `from '@velaros-ai/core/node'` | 26 个文件 |
| `logRuntime`、`LoggerFactory.create(s)` | `Log`、`Log.tag(s)` | Platform 141 处、Desktop 30、Workbench 6、Termel 2 |
| 类型 `Logger`、`ScopedLog`、`GlobalLog` | `ScopedLogApi`、`GlobalLogApi` | 约 20 处 |
| `createCallbackTransport({ … })` | 直接写满足 `LogTransport` 的对象 | 2 处 |
| `Result.ok/fail/unwrap/match/wrap/wrapSync(…)` | `results.…(…)`；类型 `Result<T>` 不变 | 约 190 处（Desktop、Workbench） |
| `new TimerScope(o)`、`TimerScope.sleep(ms, o)`、类型 `TimerScope` | `timerScopes.create(o)`、`timerScopes.sleep(ms, o)`、`TimerScopeApi` | 约 120 处 |
| `TypeGuards.isString(…)` | `isString(…)` | Desktop 1 个文件 |
| `coerceTrimmedString`、`readRecord` | `trimmedStringOrEmpty`、`asRecord` | agent 1 处 |
| `./assert` 全部、`readStringPreserveOuterWhitespace`、`peekLooseString`、`peekLooseBoolean`、`writeFileAtomicallySync`、`LogRuntime`、`LogError`、`LogAssertionError`、守卫品牌 4 个导出、`AppErrorOptions`、`LogErrorOptions` | 删除 | 零使用 |
| `ErrorCode` 里的 `LOG_FAILURE`、`LOG_ASSERTION` | 删除 | 零判断 |

产品仓配置：Desktop 的 `tsconfig.json`、`tsconfig.web.json`、`tsconfig.node.json` 为了守住品牌类型的单实例，把 `@velaros-ai/core` 与 `@velaros-ai/core/*` 钉在 `node_modules/@velaros-ai/core/dist/index.d.ts` 与 `dist/*`，要改指 `dist/exports/index.d.ts` 与 `dist/exports/*`（Workbench、Termel 没有这类钉法，只需改 import）。

### 3.6 `AppError` 的错误信封要不要立在 core：不要

- 信封是三个字段挂在 `AppError.cause` 上：`reason`（领域原因码）、`details`（结构化详情，not-applied 标记也在这里或 `context`）、`suggestedNextAction`（给模型的下一步）。写的一方是 system（2 处）与 project（10 个文件），读的一方只有 agent 的 `tools/ExecutionPolicyFailures.ts`（沿 cause 链找这三个字段，列表截到 10 项），另外 agent 还专门认 project 的私有键 `context.projectError`。
- 这是「一次工具调用失败要怎样交给模型」的约定，属于 agent 工具契约；core 的准入规矩明文排除 Agent 的工具契约与执行语义。放进 core 会让 core 认识「模型」和「工具」。
- 去处按共用逻辑方案 §3.11：`@velaros-ai/agent/tool-contract` 出 `ToolFailureCause` 类型、`ToolFailureLimits.listItems`（10）与 `createToolFailure(code, message, cause, { notApplied, applied })`；如果 agent 第 6 步把工具契约拆成独立包，就跟着去那个包。core 只负责它自己那层：`AppError` 的 `code/message/cause/context`、`CoreErrorCodes`、沿链取码与消息（`AppError.from`/`getMessage`，这些是域无关的）。

### 3.7 跨包重复的域无关原语：哪些进 core

| 原语 | 现在各写几份 | 判断 |
| --- | --- | --- |
| errno 读取 `readErrnoCode(error): Nullable<string>` | system `utils/fs.ts`；kernel（2 个类型守卫）、project、office、memory、browser、cli、document-renderer、agent、platform 各有内联写法，10 个包至少 11 处 | **进 core**（浏览器安全，只读 `.code`，不 import Node） |
| 代理对安全截取 | system 2 处、project 2 处、agent 4 处（`tool-output-store`、`FileSnapshotArchive`、`residency/admission`、`retrieval/Pagination`）、html-artifacts、development；core 自己的 `truncate` 与 `AppError` 截断反而是会切开的 | **进 core**：修 `truncate`，出 `clampToCodePointBoundary(text, index, bias)`、`takeTail(text, maxChars)`；孤立代理判定直接用 `String.prototype.isWellFormed()`（Node 20 起有） |
| 规范化 JSON `stableStringify` | agent 3 份（`KernelToolLoopGuard`、`AgentWorkflowRuntime`、`residency/determinism`，其中 `determinism` 处理 Date 与环）、agent-lab 3 份、browser 2 处按键排序 | **进 core**（agent、browser 是不相邻领域）；以 agent `determinism` 的语义为准，键按码点排序 |
| 路径文本包含判断 | — | 已定去 platform（`isPathTextInside`，已落地）；各包迁移随 text-files 之后 |
| 真实路径 | — | 已进 core（`resolveRealPath`，已落地），本方案只把它挪到 `./node` |
| 原子替换写 | core `FilePersistence`（无 fsync、写符号链接会把链接本身换成普通文件）、text-files（fsync、目录 fsync、权限位、写到链接目标、拒多硬链接）、agent-lab 2 份 | **暂不合并**：core 这份给应用自己的状态文件（Desktop 高频写，加 fsync 有性能代价），text-files 给用户的文本文件，耐久与链接语义不同；各自在文件头写明差别。要不要让 core 这份也改成 text-files 的耐久语义，见 §7-4 |
| HTML 转义 | agent-lab 3、office 1、html-artifacts 1 | 不进：能用 core 的只有 office 一个领域，不满足「两个不相邻领域」 |

## 4. 文字

- 英文报错两处：`optionalWhen` 的 TypeError（`optionalWhen only accepts TypeGuards predicate functions…`）、重复 transport（`[LogRuntime] Transport already exists: …`），改中文。
- 控制台前缀 `[ERR]` 等是日志格式，不是给用户的句子，不动。
- `README.md` 按新入口重写（中文），「公开入口」表改成三行。

## 5. 实现层缺陷

1. **`truncate` 会切开代理对**（已复现）：`truncate('ab😀cd', 3)` 得到 `"ab\ud83d…"`，`isWellFormed()` 为假。它被用在交给模型的文字里（agent `PromptState` 的失败摘要、memory 知识检索的片段、agent 工具空间摘要等 35 处）；agent 的历史清洗会把孤立代理换成 U+FFFD，不经清洗的路径原样发出。
2. **`AppError.getMessage` 的字符串化截断同样会切开**（已复现：600 个 emoji 的对象，截到 1,000 字符后 `isWellFormed()` 为假），错误消息会进日志、IPC 与工具失败回执。
3. **`LogRuntime.pause()` 的缓冲没有上限**：暂停期间每条日志都进数组，直到 `resume`。全仓零调用，随 API 收窄删除。
4. `AppError.from` 把 `context` 是数组的普通对象也当成序列化错误收下（`context` 类型声明是 Record）；`package.json` 的 `files` 列了不存在的 `docs` 目录；`scripts/core/check-package-consumers.mjs` 没有接进任何脚本，而且断言 `main` 必须是 `./dist/index.js`、`files` 必须含 `docs`，与五目录布局矛盾——孤儿脚本，建议删除。
5. `FilePersistence` 写一个符号链接路径时 rename 会把链接本身换成普通文件、原目标不再更新（与 text-files 的语义相反）。应用状态文件很少是链接，风险低；在文件头写明，或随 §7-4 一起改。

## 6. 步骤、检查、共享文件与节奏

**第一段（0.4.x，只增不删，随时可做，不碰调用方）**
1. 修 §5-1、§5-2；新增 `readErrnoCode`、`clampToCodePointBoundary`、`takeTail`、`stableStringify`、错误码 `UNAVAILABLE`；两处英文报错改中文；补 `AppError`、`Result`、`TimerScope`、`optionalWhen`、原子写的测试。
2. 删孤儿脚本、`files` 里的 `docs`。

**第二段（0.5.0，破坏性，等 agent/browser/memory/kernel 搬家落地后一次做，由一个执行代理独占）**
1. 门禁加「原语包」档（`publicUtils`、`publicClasses`，含反向实测：别的包登记 `publicUtils` 应当被拒），`module-ownership.md` 补一段。
2. 按 §2 搬家与改名；`spec/invariants.md`（建议：INV-1 根入口与 `./contracts` 不碰 Node（门禁）；INV-2 core 不出现领域词（门禁 `check:core-semantic-vocabulary`）；INV-3 `package.json` 没有任何依赖；INV-4 跨模块副本的 `AppError` 也认得出（名字、码、消息为字符串的 Error）；INV-5 `AppError.from` 沿 error/cause/lastError/errors 链取第一个有效码，不把非 AppError 的原码冲掉；INV-6 取消息时凭据类字段一律打码、长度有上限、不切代理对；INV-7 所有截断不切代理对；INV-8 控制台管道关闭不会让日志运行时抛出；INV-9 作用域释放后其下所有计时任务与子作用域都已取消；INV-10 `optionalWhen` 只认登记过的守卫；INV-11 真实路径追悬空链接、成环返回字面路径）与验收；`MODULE.md`。
3. 一次性 codemod（放草稿区，不进仓库）：改说明符、`logRuntime → Log`、`Result.x → results.x`、`new TimerScope → timerScopes.create`、类型改名；对 Platform 全部包跑，再逐包 typecheck。
4. 登记，core 升 0.5.0，所有依赖 core 的包按发版手册同一班车升补丁号；产品迁移表交给 Desktop、Workbench、Termel 升级时用。

检查：`bun scripts/ownership/check-module-ownership.mjs --only core`（以及全量，确认别的包不受新档影响）、`bun run --cwd packages/core test`、`bun run check:core-semantic-vocabulary`、`bun run typecheck`（全仓）、`bun run lint`、`bun run test`、`bun run test:suites`、`bun run check:code-style`、`bun run check:host-contract-consumer`（夹具 `runtime.mjs` 用 `logRuntime`）、`bun run check:agent-public-api`（agent 公开签名里有 core 的类型名，改名会动基线）、`bun run check:package-catalog`、`bun run check:lockfile-consistency`。

共享文件：`scripts/ownership/check-module-ownership.mjs` 与 `governed-modules.mjs`、`docs/architecture/module-ownership.md`、根 `tsconfig.json`（core 的 paths 改指 `src/exports/*`）、`packages/core/tsconfig.json`（自引用 paths）、`arch-guard.config.mjs`（`skipPatterns` 里的 `typeGuards.ts`、`logger/`、`optionalWhen.ts`、`mapDefined.ts` 与 `forbid-raw-timers` 的 `TimerScope.ts` 放行名单都要改新路径）、`eslint/core.config.mjs`（`packages/core/src/logger/**` 的 no-console 放行）、`scripts/core/build/fix-esm-extensions.mjs`（改用 capabilities 那份）、`scripts/release/fixtures/host-contract-consumer/runtime.mjs`、`baselines/agent/public-api.json`、`docs/generated/package-catalog.json`、`bun.lock`，以及 Platform 里约 300 个 import core 子路径的文件。

## 7. 需要拍板

1. **门禁加「原语包」档，还是把 core 的函数包成类**：推荐前者（§2.1）。后者不改门禁：每组函数写成「接口 + 无状态类 + 实例 + `export const isString: TypeGuardsApi['isString'] = typeGuards.isString` 式的逐名别名」，调用方不用改，但声明量约三倍、类没有状态违背「用不到实例状态的放 utils」，而且这种别名写法任何包都能拿来绕过「utils 函数不出包」。
2. **`Result` 的值改名 `results`**（类型 `Result<T>` 不变，约 190 处调用改写）：同名值与类型分放 types 与 impl 后无法从一个入口一起导出。备选是给门禁再开一个「同名伴生类型可以留在 utils」的口子，调用方不动。推荐改名。
3. **`TimerScope` 改成 `timerScopes.create()` / `timerScopes.sleep()`**（约 120 处）：与标准「类不出包、出工厂」一致；备选是把它也列进 `publicClasses`，调用方不动。推荐改。
4. **core 的原子写要不要升到 text-files 的耐久语义**（写完 fsync、目录 fsync、写到链接目标、保留权限位）：更安全，但 Desktop 的会话账本等高频写会变慢。推荐保持现状、两边文件头写明差别，等有数据再说。
5. **执行时机**：第二段必须等 agent 等大包搬家落地（它们合计 400 多个文件 import core），推荐排在其余包全部完成之后、作为地基重构的收尾一步，与产品升级 Platform 同一次进行。
