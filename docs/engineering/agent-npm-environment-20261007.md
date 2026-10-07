# Agent 持久 npm 环境交付差量

Agent 现在可以通过 `velaros:system.environment` 搜索、查看、安装、更新、替换、删除 npm 包，并回滚到仍保留的环境版本。安装成功后，当前已打开会话的下一次 Node 或 Shell 执行自动使用新环境；运行中的执行及其后代保持启动时的版本。

## 使用流程

模型先读取环境，再提交依赖变更：

```js
import { environment } from 'velaros:system'

const current = await environment.list()
const next = await environment.apply({
  baseRevision: current.revision,
  install: ['yaml@2'],
})
console.log(next)
```

下一次执行即可使用实际安装的包：

```js
import { parse } from 'yaml'
console.log(parse('enabled: true'))
```

`search({query, limit})` 查找候选包，`describe({package})` 查询版本、用途、Node 要求和依赖。`list()` 返回实际版本、README、package.json、命令名与历史版本。模型说明要求安装后读取真实文档并验证目标功能。

`apply` 的同名 `install` 可升级或降级；`remove` 和不同名的 `install` 可在一次发布中完成替换。`rollback({baseRevision, revision})` 将保留历史发布为新版本，版本号仍递增。每次变更都携带当前 `baseRevision`，冲突后重新查询。

## 公开合同差量

| 合同 | 变更原因 | 调用方影响 |
| --- | --- | --- |
| `velaros:system.environment` | 将依赖自管理放在 Act system 的固定职责中 | 新增 `list/search/describe/apply/rollback`；写操作只允许 execute，全部经过 Kernel 授权、效果核对与回执 |
| `@velaros-ai/velaros/act/system` | 由宿主绑定 agent 的持久作用域 | 导出 `createEnvironmentRegistry`、注册表 API、选项、租约和模型使用的数据类型；模型不传安装目录 |
| Runtime 的 `packageEnvironment` 与 `RuntimeNodeOptions.npm` | 让标准装配自动提供依赖管理，同时支持自定义执行宿主 | 提供 `dataDir` 和 npm 客户端时默认装配；可注入注册表，或用 `false` 关闭 |
| `createNodeExecutionEnvironment` 的 `npmCli/npmCacheDirectory` | npm 与 Node 运行共用宿主执行策略 | 自动提供 npm 客户端；产品可显式指定随产品分发的 `npm-cli.js` 和缓存目录 |
| Script 的 `NodeCodeRunnerOptions.acquireRuntime`、`NodeRuntimeLease` | 每次执行读取新环境，并保护仍在运行的版本 | 可选回调优先于固定 `runtime`；返回依赖、命令目录、释放与保留方法，现有固定配置继续可用 |
| `NodeProcessRequest.binDirectories` | 让已安装 CLI 与 import 使用相同版本 | 标准执行口将目录加入本次进程 PATH，子进程继承 |
| execution 的 `createNpmClient` 与 `NpmClientApi` | 将 npm 进程机制集中在 execution | 提供安装、锁文件恢复、搜索和元数据查询；Skill 安装器复用此客户端，按已有锁文件继续使用 `npm ci` |

TS 操作接口是模型合同来源，声明、派生 schema、版本、效果与模板经 `generate:script` 生成。Act 能力目录经 `generate:act-catalog` 更新，`system-environment.d.ts` 纳入基线。

## 宿主装配与执行语义

- 默认持久目录为 `dataDir/environments/default`。宿主用稳定的独立目录区分 agent；环境目录及其真实路径必须在业务工作区之外。受约束宿主需授权安装根和 npm 缓存的写入。
- npm 命令通过标准 `ShellHostPort` 执行，共用宿主沙箱、网络策略、取消、超时和进程树回收。CLI 从指定位置或 Node/PATH 的真实 npm 安装中查找。无法找到时返回可诊断错误，宿主可显式配置 `npmCli`。
- 直接安装规格支持 registry 包名、semver 范围、标签和 npm alias。新增依赖保存精确版本，保留锁文件；生命周期脚本默认关闭，确有构建需要时可传 `allowScripts: true`，仍沿用宿主权限。
- 每次变更在独占的新目录安装，核对清单、锁文件、包版本及目录边界后原子发布。目录从安装开始就使用最终位置，避免原生构建产物记录的绝对路径在发布时失效。
- 安装、取消或发布冲突均保留原指针。校验拒绝记 `effect: none`，npm 已执行但发布未确认时记 `unknown`，指针发布成功记 `committed`。
- 一次执行只获取一个快照。ESM、CommonJS、包子路径、间接依赖、CLI 与 Node 子进程使用该快照；业务工作区的实际依赖遵循原生解析优先级，固定 Skill 导入名冲突时使用 npm alias。
- 最近保留 16 次发布，额外保留仍有执行租约的安装目录。正常结束释放租约并回收过期目录；进程树回收不完整时保留候选或运行快照，供宿主核对后清理。
- 单个安装包损坏不阻断诊断程序启动，Agent 可以再次安装修复；回滚会核对目标安装事实。清单或锁文件损坏时返回明确冲突，可恢复到完整历史。

直接依赖最多 128 个；单次安装、删除各最多 32 项；规格最多 256 字符，包名最多 214 字符；搜索默认 10 项、最多 20 项。模型文档和运行时校验使用同一常量表。npm 命令超时为 300 秒，输出有界。

## 验收承诺变化

- system 新增 INV-23，覆盖真实 npm 下载、持久化、同会话生效、并发发布、取消、版本保护与回收。
- Script 对固定依赖环境的承诺扩展为每次执行可获取独立快照；原有固定 `runtime` 的行为继续成立。
- Runtime 说明增加标准装配条件、稳定作用域和下一次执行生效的约定。已有描述环境的 `environment` 回调保持原职责，依赖管理使用独立的 `packageEnvironment`。
- system 目录验收按真实装配检查成员：自定义 runner 未绑定 npm 环境时，目录只展示实际可用的系统成员。
- npm 机制被 Skill 安装复用；原 Skill 选择、授权、租约和能力装配继续沿现有链路验证。

## 验证记录

新增 8 组环境验收使用本地 HTTP npm registry、真实 npm CLI 和真实打包产物，覆盖：搜索与元数据、安装升级、ESM/CJS、子路径、间接依赖、CLI、Node 子进程、alias、构建脚本、重启、回滚、替换删除、同一会话即时衔接、宿主拒绝、运行中版本冻结、引擎不兼容、取消、并发 CAS、历史回收、工作区优先级、回收不完整和损坏包修复。测试打包复用 `safe-package-pack.mjs` 的独占临时目录与进程回收。

Script 与 Skill 的 7 个测试文件共 185 项通过。system 与相关 Runtime 的 6 个测试文件最终整组复核 115 项通过，其中包含上述 8 组新增环境验收；合计 300 项通过，0 失败。

Script、Velaros 构建与类型检查通过。`check:module-ownership`、`check:script`、`check:act-catalog`、README 示例、错误构造、能力架构检查通过；全仓 lint、Prettier 检查通过，`git diff --check` 通过。

提交前全仓代码风格门通过，共 37 项。模型重试的 JSON 响应体解析使用 `optionalWhen`，解析失败记录固定调试说明，不记录第三方响应正文；相关模型回归 22 项通过。错误正文长度常量的中文说明与模块所有权检查一致。

这轮验证覆盖确定性的执行与环境管理链路。模型面对真实任务时的选包质量与成功率需要另行任务评测。
