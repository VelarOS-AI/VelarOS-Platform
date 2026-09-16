# `@velaros-ai/cli` 按仓库标准改造方案

> 对象：`packages/cli`（0.2.17，`velaros` 命令的唯一发行包），HEAD `606fba59`（数据采于 `7c39d5c9`；其后本范围内只有 core `utils/RealPath.ts` 的写法微调 `0ac2b5f1`，结论不变），本包工作区干净。
> 标准同其它方案。能力归属表里它属于 `composition` owner（`scripts/capabilities/capability-owners.mjs`，`entrySubpaths: ['.']`）。
> 基线：`bun test test` 10 pass / 0 fail（测试跑的是 `dist/`）。复现脚本在草稿区 `plan-small/probe-cli/`。

## 0. 结论先行

- **规模**：`src/` 8 个源文件 592 行；入口 `.`、`./cli`；`bin: velaros → dist/bin.js`。
- **库面没有任何消费方**：全仓与 Desktop、Workbench、Termel、Extension 零 import，产品 `package.json` 也不依赖它；用到的只有 `velaros` 可执行文件。
- **`velaros agent status` 读的 `.velaros/agent-runs` 已经没有任何生产者**：Platform 与 Desktop、Workbench、Termel 里只有本包提到这个目录，没有任何写入方。这是一个空转的命令（§7 拍板）。
- **主要问题**：两个类都没有接口、类出包；用户看得到的文字全英文；环境变量 `VELAROS_TERMEL_COMMAND` 没登记；`bin.ts` 在 `src` 里带副作用。
- **真 bug 两个**：任务指针的越界判定只按字面路径，仓库里放一个符号链接就能让 `agent status --full` 打印工作区外的 JSON（与代码注释里声明要挡住的威胁一模一样）；选项写在子命令前面会被当成子命令。另有一个 Windows 问题：`velaros terminal` 用 `spawn('termel')` 不经 shell，npm 装出的 `termel.cmd` 起不来。
- **目标**：`VelarosCliRouter`（类上方接口 `VelarosCliRouterApi`，工厂 `createVelarosCliRouter`，默认实例 `velarosCli`）+ 两个命名空间类 + 错误类；注入面只有「命名空间执行器」；入口 `.`、`./contracts`；可执行文件移到包根 `bin/velaros.js`。

## 1. 现状

| 文件 | 行 | 内容 |
| --- | ---: | --- |
| `router.ts` | 129 | `VelarosCliRouter` 类（无接口）、`createVelarosCliRouter`、`runVelarosCli`、英文帮助 |
| `agent.ts` | 240 | `agent` 命名空间：`help`/`manifest`/`status`，任务指针解析与越界判定 |
| `terminal.ts` | 39 | `terminal` 命名空间：`spawn(VELAROS_TERMEL_COMMAND ?? 'termel')` |
| `output.ts` | 79 | 成功/错误信封与文本格式化 |
| `types.ts` | 54 | 信封类型、`VelarosCliSchemaVersion`、`VelarosCliError` 类 |
| `cli.ts` | 31 | 重新导出 + `main()`（写进程输出） |
| `bin.ts` | 9 | `void main().catch(…)`（副作用） |
| `index.ts` | 11 | 转发 `cli.ts`、`output.ts`、`types.ts` |

根入口导出 18 个符号、`./cli` 7 个（`VelarosCliRouter` 类、`VelarosCliError` 类、`formatVelarosCliSuccess/Error`、`normalizeVelarosCliError`、`main`、`runVelarosCli` 等），全部零消费方。`check:public-readiness` 单独核对本包不许回装 `@velaros-ai/remote-host`、`serve-host`。

## 2. 目标布局

```text
bin/velaros.js          可执行文件（包根，不在 src）：import { velarosCli } from '../dist/exports/index.js'，写 stdout/stderr、设退出码
src/
  contract/   provides.ts（VelarosCliRouterApi）、requires.ts（VelarosCliNamespaceRunner）、constants.ts
  types/      cli.ts（可移植：信封、运行结果）；options.ts（带 write 回调的运行选项、路由选项）
  impl/       VelarosCliRouter.ts、AgentTaskNamespace.ts、TerminalNamespace.ts、VelarosCliError.ts
  utils/      output.ts（信封与文本）、arguments.ts（选项解析）、task-paths.ts（任务标识与指针判定）
  exports/    index.ts、contracts.ts
```

| 现有 | 去处 |
| --- | --- |
| `router.ts` | `impl/VelarosCliRouter.ts`；帮助文本进类的 `private static readonly` |
| `agent.ts` | `impl/AgentTaskNamespace.ts`（类，`run(argv, options)`）+ `utils/arguments.ts`、`utils/task-paths.ts` |
| `terminal.ts` | `impl/TerminalNamespace.ts`，启动命令改用 `@velaros-ai/platform` 的命令规格（Windows 走 shell） |
| `output.ts` | `utils/output.ts`（纯函数，不出包） |
| `types.ts` | 信封类型进 `types/cli.ts`；`VelarosCliSchemaVersion` 进常量表；`VelarosCliError` 进 `impl/VelarosCliError.ts`（错误类不出包） |
| `cli.ts`、`bin.ts`、`index.ts` | 删除；进程包装进 `bin/velaros.js` |

登记表：`portable: 'cli.ts'`，`environmentTable: 'CliEnvironmentVariables'`，`browserSafeEntries: ['contracts.ts']`，`layers: [['VelarosCliRouter.ts'], ['AgentTaskNamespace.ts', 'TerminalNamespace.ts'], ['VelarosCliError.ts']]`。

## 3. 合同草案

**provides：`VelarosCliRouterApi`**（类上方）

| 成员 | 说明 |
| --- | --- |
| `listNamespaces(): readonly string[]` | 构造后冻结的命名空间集合 |
| `run(argv: string[], options?: VelarosCliRunOptions): Promise<VelarosCliNamespaceRunResult>` | 路由一次；未知命名空间与命名空间抛的错都收成错误信封，永不向宿主抛 |

出包的值：工厂 `createVelarosCliRouter(options): VelarosCliRouterApi`（README 写给产品开发者的扩展点，保留）与默认实例 `velarosCli: VelarosCliRouterApi`（带内置命名空间，`bin/velaros.js` 用它）。

**requires：`VelarosCliNamespaceRunner`**——宿主注册的命名空间执行器：`(argv, options) => 结果或 Promise`；只返回 `text`、`exitCode` 与可选的透明 `envelope`，不许回调路由器。

**constants**

| 表 | 内容 |
| --- | --- |
| `VelarosCliEnvelope` | `schemaVersion: 1`、`errorKind: 'velaros.cli.error'` |
| `VelarosCliErrorCodes` | `UNKNOWN_NAMESPACE`、`UNKNOWN_COMMAND`、`INVALID_ARGUMENT`、`EXECUTION_ERROR`、`TERMEL_NOT_INSTALLED`、`TASK_NOT_FOUND`、`INVALID_TASK_ID`、`INVALID_TASK_POINTER`、`INVALID_TASK_JSON`，每个写明退出码（2 = 用法错、1 = 执行失败、127 = 找不到命令） |
| `CliEnvironmentVariables` | `VELAROS_TERMEL_COMMAND`：替换 `velaros terminal` 启动的命令 |

**要删的导出**：`VelarosCliRouter`（类，改工厂）、`VelarosCliError`（错误类不出包，外面按信封里的 `error.code` 判断）、`runVelarosCli`、`main`、`formatVelarosCliSuccess`、`formatVelarosCliError`、`normalizeVelarosCliError`、`FormatVelarosCliSuccessInput`、`./cli` 入口。无外部消费方，不需要迁移表；README 的示例从 `new VelarosCliRouter({…})` 改成 `createVelarosCliRouter({…})`。

## 4. 用户面文字

全部英文：两份帮助、9 条错误信息（`Unknown namespace: …`、`Termel is not installed. …`、`Latest agent task pointer escapes the workspace root.` 等）、`agent` 的三条命令摘要。按标准第 10 条改中文，错误码、选项名、命令原样保留（例如「未知的命名空间：quality。可用：agent、terminal」）。`--json` 信封的字段名与 `kind` 不变。由于 `velaros` 是公开发行的命令，是否整体中文见 §7。

## 5. 实现层缺陷

1. **符号链接绕过任务指针的越界判定，能打印工作区外的文件**（`agent.ts` 的 `assertPathWithinWorkspace` 只比字面路径，`readJsonRecord` 读时跟随链接）。复现（草稿区）：工作区里放 `.velaros/agent-runs/link.json → 工作区外/credentials.json`，`latest-task.json` 写 `{"taskJsonPath": ".velaros/agent-runs/link.json"}`，`velaros agent status --workspace-root <ws> --full --json` 把外面那份 JSON（含 `apiKey` 字段）原样打到 stdout。代码注释明确要挡「克隆一个恶意仓库就能读任意文件并打印」。修法：工作区根与目标都先 `resolveRealPath`，再用 `currentPlatform.isPathTextInside(real, realRoot, { caseSensitive: true })`；`--task-id` 路径同样处理。
2. **选项写在子命令前面会被当成子命令**：`velaros agent --workspace-root /x status` 取第一个不以 `-` 开头的参数当命令，结果把 `/x` 当命令，回 `UNKNOWN_COMMAND`。复现已跑。修法：按「带值选项」表跳过选项值。
3. **Windows 上 `velaros terminal` 起不来 npm 装的 Termel**：`spawn(command, argv, { stdio: 'inherit' })` 不经 shell。Windows 上 npm 装出来的是 `termel.cmd` 垫片，不经 shell 时不会按 PATHEXT 去找它，得到 ENOENT；就算写成 `termel.cmd`，Node 18.20 / 20.12 起不经 shell 启动 `.cmd` 也会报 EINVAL。结果被报成 `TERMEL_NOT_INSTALLED`，误导用户。修法：用 platform 的命令规格或 `shell: true`。本机无 Windows，列为待实机验证。
4. 被信号杀死时退出码写成 1（惯例是 128 + 信号号），小问题，顺手改。

## 6. 步骤、检查与共享文件

1. 合同、类型、四个类、三份 utils；修 §5；`bin/velaros.js`；`package.json` 的 `bin`、`files`（加 `bin`）、`exports`；删 `mark-executable` 对 `dist/bin.js` 的调用，改标记 `bin/velaros.js`。
2. `spec/invariants.md`（建议：INV-1 路由器永不向宿主抛，未知命名空间退出码 2；INV-2 命名空间集合构造后冻结；INV-3 任务标识只许单段名字、指针按真实路径不许出工作区；INV-4 `--json` 信封字段与 `schemaVersion` 固定；INV-5 `./contracts` 不碰 Node（门禁））与验收；现有 `test/cli.test.mjs` 的 10 条迁成验收或实现测试（仍可跑构建产物）；`MODULE.md`；README。
3. 登记，升 0.3.0。

检查：`bun scripts/ownership/check-module-ownership.mjs --only cli`、`bun run --cwd packages/cli test`、`bun run check:capabilities-arch`（owners 表的 `entrySubpaths` 改成 `['.', './contracts']`；README 必须中文且不短于 400 字）、`bun run check:public-readiness`、`bun run check:package-pack-boundary`、`bun run check:package-catalog`。

共享文件：`scripts/ownership/governed-modules.mjs`、`scripts/capabilities/capability-owners.mjs`、根 `tsconfig.json`（paths 指 `src/exports/*`）、`docs/generated/package-catalog.json`、`bun.lock`；依赖新增 `@velaros-ai/platform`（composition owner 可以依赖任何包）。

## 7. 需要拍板

1. **`velaros agent` 命名空间留不留**：它读的 `.velaros/agent-runs` 目前没有任何组件在写。三个选择：删掉（CLI 只剩 `help` 与 `terminal`，也最省改造量）；保留并在 Termel 或 Desktop 里补上写这份目录的一方；或改读别的真实存在的任务记录。建议删，等有生产者时再加回来。
2. **`velaros` 的帮助与报错是否整体中文**：它是公开 npm 包，标准第 10 条要求用户看得到的文字用中文；如果打算面向英文用户，需要明确豁免（例如跟随系统语言）。建议按标准改中文。
3. **库面（`createVelarosCliRouter`）留不留**：零消费方，但 README 把它写成给产品注册运维命名空间的扩展点。建议保留工厂、删掉其余格式化函数。
