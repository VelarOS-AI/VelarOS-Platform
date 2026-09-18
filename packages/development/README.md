# `@velaros-ai/development`

项目代码理解背后的语言服务库。模型看到的能力是 `velar:code`（`@velaros-ai/velar/project`），本包不带工具、也不参与 Mod 装载，
只提供可复用的实现：宿主拿它实现项目工具的空间端口 `ProjectSpacePort.queryCode` 的语言服务那一半。

## 两个入口

- `@velaros-ai/development`：四件能力与三个注入点，要读磁盘、要拉子进程，只给 Node。
- `@velaros-ai/development/contracts`：常量表与可移植数据类型，整条链不碰 Node，渲染进程与浏览器都能加载。

```ts
import { createProjectCodeQuery, languageQueries, typeScriptProjects } from '@velaros-ai/development'

// project 的注入面：语言服务类动作走内置实现，代码图谱类动作交给宿主的图后端
const queryCode = createProjectCodeQuery(codeIndex)

// 只给得起「列文件 / 读正文 / 列符号」的宿主，直接用语言查询
await languageQueries.run({ action: 'find_symbols', query: 'UserService', exact: true }, context)

// 关闭项目时释放这个项目的 TypeScript 语言服务
typeScriptProjects.release(projectRoot)
```

`LanguageToolContext` 只有中止信号、项目根与只读内核端口（`listFiles` / `read` / `listSymbols`）。
语言查询不消耗项目的修改、执行与审批能力，宿主给的内核就算带着写入口，本包也够不着。代码图谱后端
（`ProjectCodeIndexApi`）是可选的，给一个永远不可用的空实现也合法：此时内置的七个语言动作照常可用，
代码图谱类动作抛 code 为 `UNAVAILABLE` 的错误，由 project 写成降级说明。

## 诊断

`language_diagnostics` 的 `path` 可以是文件或目录。目录按 `extensions` / `maxDepth` 选出 JavaScript/TypeScript
源文件：`extensions` 里的非 JS/TS 扩展名（`vue`、`json` 等）被忽略并在 `note` 里说明；遍历跳过 `.gitignore`
忽略的文件，以及 `node_modules`、`dist`、`build`、`out`、`coverage` 等依赖与构建目录（`path` 显式指向这类
目录内部时照常诊断）。单次最多 200 个源文件、耗时预算 20 秒（`DevelopmentCodeLimits`）；任一闸触发时在
`note` 里说明还有文件没诊断。选中的文件按各自所属的 tsconfig 分组，每组只构建一次程序，诊断结果与逐个
文件单独诊断一致；文件之间让出事件循环，中止信号在两个文件之间生效。没有扫描到任何文件时 `note` 会写明
原因，空结果不会伪装成「全部通过」；结果按错误、警告、提示的顺序排列后再按 `limit` 截断。

`find_references` 凑够 `limit + 1` 条就停止扫描，此时 `referenceCountIsLowerBound` 为真、`note` 里写明
引用数是下限——它和真实总数的 `importerCount` 并排交给模型时分得清。

## 标准库

TypeScript 类型诊断依赖标准库声明（`lib.*.d.ts`），按以下顺序定位：

1. `typescript` 包自身所在目录（开发环境与未剔除 `.d.ts` 的安装）；
2. 宿主调用 `typeScriptProjects.configureLibraryDirectory(absoluteDir)` 显式声明的目录；
3. Electron 约定目录 `<process.resourcesPath>/typescript/lib`。

目录必须含编译选项实际加载的标准库（`compilerOptions.lib`，未设置时为默认库）及其经 `/// <reference lib>`
传递引用的全部文件才算命中，残缺的目录会被跳过。Electron 打包默认剔除 `node_modules` 里的 `.d.ts`，宿主应把
`node_modules/typescript/lib/lib*.d.ts` 作为 extraResources 放到 `typescript/lib`，即可在不改代码的情况下命中
第 3 条。三处都没有完整标准库时，诊断结果带 `degraded` 说明并只返回语法诊断，不会把 `Cannot find name 'Record'`
这类由标准库缺席导致的伪错误当作真结果返回。

## 语言服务池

每个（项目根，tsconfig）常驻一个 `ts.LanguageService`，同一项目的连续查询共用增量缓存——这是诊断能在一两秒内
回答的原因。池按最近使用淘汰，宿主也必须在关闭项目时调 `typeScriptProjects.release(projectRoot)`，退出时调
`typeScriptProjects.release()`：长跑的宿主打开的项目越多，占用越大。

## 外部语言服务

`createExternalLanguageService(projectRoot, specs?)` 负责用户本机已装好的 language server 的进程生命周期、
JSON-RPC framing、超时与取消，以及诊断与跳转结果的有界归一。只启动规格表（`BuiltinExternalLanguageServers`
或宿主自己给的表）里的命令，只解析项目根以内的文件，不会静默下载或启动任意可执行文件。二进制与资源发现、
启用策略、状态展示仍归宿主。

「等到超时也没收到诊断」与「真的一条问题都没有」在返回值里长得一样，所以超时的文件数记进 `status()` 的
`diagnosticsTimedOutFiles` / `diagnosticsComplete`：调用方据此判断这次的空结果能不能当成「没问题」。

结构、不变量与分层见 `MODULE.md` 与 `spec/invariants.md`。
