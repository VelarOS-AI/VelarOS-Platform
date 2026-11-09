# Skill 与标准 Node 运行环境

产品能力管理使用 `@velaros-ai/velaros/features` 的合同，模型入口是 `velaros:features`。本单元继续承担底层依赖、代码合同与租约适配；下面的 Skill 包描述属于这层内部运行机制。Feature 模块可以通过 `sdkCapabilities` 声明宿主 SDK，使用 `velaros:host.invoke` 派生调用，每次重新经过 Kernel 授权，沿用父身份、模式与取消，禁止只读操作转发写入。

Skill 是可以安装、升级和卸载的包。Agent 始终在标准 Node.js 中执行；Skill 按需要贡献标准 npm 包、说明、资源和外部能力。

```mermaid
flowchart TD
  package[Skill 包] --> registry[本机安装库]
  registry --> selection[会话选择与能力授权]
  selection --> environment[固定版本的运行环境]
  environment --> node[Node.js + 标准 npm API]
  environment --> catalog[按需发现目录]
  catalog --> instructions[SKILL.md 与资源]
  catalog --> contract[生成的 TypeScript 能力合同]
  contract --> kernel[Kernel 授权与执行回执]
  kernel --> provider[受控 Node 能力进程]
```

## 包格式

普通 npm 元数据、版本、依赖和 Node 版本约束沿用 package.json。`agentSkill` 只声明贡献：

```json
{
  "name": "release-review",
  "version": "1.0.0",
  "description": "核对项目发布准备情况",
  "engines": { "node": ">=22.15.0" },
  "dependencies": { "semver": "7.8.5" },
  "agentSkill": {
    "instructions": "SKILL.md",
    "packages": ["semver"],
    "capabilities": [
      { "module": "skill:release-review", "entry": "provider.mjs", "contract": "provider.d.ts" }
    ]
  }
}
```

五类贡献为 `instructions`、`packages`、`capabilities`、`hostCapabilities` 与 `sdkCapabilities`，都可省略，但至少提供一类。`packages` 只列公开给 Agent 的裸包名；其余依赖留在 Skill 内部。包可以公开自己，也可以公开 dependencies 的直接依赖。标准包保持原本的 API、exports 和子路径。`hostCapabilities` 由宿主绑定实际资源，`sdkCapabilities` 允许扩展经 Kernel 调用已声明的宿主 SDK；声明本身不授予权限。

纯说明目录只需要带 name、description frontmatter 的 SKILL.md。安装时在暂存副本生成清单，源目录保持原样。说明、脚本和资源路径均相对 Skill 安装目录。

## 使用与发现

宿主可通过 `createSkillSession({ registry, selection })` 启用按需会话：全部已安装 Skill 的用途进入发现目录，selection 只预加载工作区默认项与手动选择。宿主经 `session.catalog` 发现并调用 `activate`，或在能力调用时装配所需依赖；并发重复加载合并，每次程序保持自己的固定快照，新增 npm 包从下一次执行使用。session 传给能力装配，并以 `acquireRuntime` 提供 Node 快照。全部前台与后台执行收束后才 release。固定选择宿主仍可使用 `registry.acquire()`。

基础任务环境不公开 `typescript` 和 `ts-morph`；它们与格式化、结构搜索及网页测试依赖统一由 `jsts` 按需提供。Script 内部保留工具合同编译所需的 TypeScript 依赖，该内部依赖不进入模型默认包目录。工作区已有 npm 依赖仍按原生 Node 规则优先解析。

基础 npm 只提供 `execa`、`@vscode/ripgrep`、`globby` 和 `diff`；普通文件与 JSON 处理使用 Node 标准库。其他库不作为 Script 基础依赖保存，由实际使用的工作区或能力模块自行声明。宿主模块用于 YAML、校验、Office 等功能的内部依赖不自动进入模型包目录。

产品宿主管理 Feature 的导入、安装、启停和工作区选择，保存确切代次及声明能力授权。升级后重新选择，已有队列不会自动获得新能力。底层 Registry 继续负责静态校验、安装收据、成功发布通知、不可变目录、授权核对和回收；不再接收另一条 plugins 注入轨。宿主现有 Feature 分发与 provider 生命周期保持独立。

模型从 `velaros:features` 按需 import：guide 查询 Feature、Codex Skill 导入和宿主 SDK 规范；list 查询能力用途与当前状态；load 按身份读取本轮可用能力的说明和资源；validate 静态校验来源；install、remove 经宿主确认管理本机来源。旧 `velaros:skills` 模型管理面已退役。未挂载 Feature 模块时，经实际 `$VELAROS_HOST_DIR/index.json` 的 skills 目录和 instructions 路径按需读取普通说明文件，不假定管理模块存在。普通目录创建与 npm 使用仍由 Node 执行，来源约束由实际宿主操作核对。

安装默认关闭依赖生命周期脚本，需要时明确申请；进行中的安装可取消。注册处成功发布后通知订阅者，设置页与聊天候选列表直接刷新。说明正文和开发规范只在查询时返回。

每次执行提供 `$VELAROS_HOST_DIR/index.json`：

- `environment`：本次固定的环境身份。
- `packages`：基础包与 Skill 公开包的实际版本、解析根、原包目录 `root`、清单 `packageJson` 以及包自带的 `readme` 入口。
- `skills`：用途、安装目录、说明路径及当前执行可用的能力。
- `capabilities`：已授权模块及生成的合同、客户端路径。

发现目录通过普通文件读取；说明正文按任务需要读取。标准 npm 包保留原始 README、package.json、类型声明与发布代码，模型可按实际安装版本核对 API、exports、参数和示例。原包的类型入口从 package.json 的 types、typings 或 exports 获取，资源也随应用分发。标准库与 npm API 无额外教程。增加 Skill 数量不会增加常驻系统提示中的说明正文。

工作区已有依赖优先；缺失包再解析本次环境。ESM、CJS、createRequire、保存脚本和继承执行环境的 Node 子进程采用相同规则。损坏的工作区依赖保留原本错误。不同会话可以选择各自的依赖版本；同次选择的公开包名冲突在环境组装时明确失败；同版本且内容一致的贡献可以复用。

## 外部能力

外部能力使用 `skill:<名称>` 或 `feature:<身份>`，由实际贡献和宿主装配决定。provider.d.ts 提供自包含的具名函数声明，每个函数接受零个参数或一个 JSON 参数，并写明 `@OperationEffect none` 或 `write`。只在执行入口使用的操作标记 `@OperationModes execute`。合同、参数校验与发现内容由同一 TypeScript 编译器派生。

包源码只在受控 Node 子进程中运行，继承当前工作区的进程权限、时限与取消。能力调用经过 Kernel；本次租约决定能力授权，每次派发重新核对安装代次。卸载或升级会拒绝旧代次的后续调用。已经派发的调用按原执行时限和取消链路收束。

标准 Node 文件、进程、网络操作由操作系统执行边界管理。Skill 能力授权控制宿主能力桥；普通 npm 代码使用当前 Node 进程本身具备的权限。

## 生命周期与存储

产品基础依赖由应用随包分发并校验。用户安装位于应用数据根 `skills/`，包括暂存区、不可变安装代次、环境快照和租约。依赖准备使用应用自带 Node 与 npm：已有锁文件使用 npm ci，否则 npm install 生成锁文件；发布不依赖系统 PATH 中的 Node 或 npm。

只有依赖准备、入口合同和内容散列全部通过后，才在跨进程锁内原子切换索引。失败或取消保留之前的有效安装。租约固定依赖版本和能力集合；按需会话在每次执行前取得固定快照，显式选择只决定预加载；新增依赖从下一次程序执行生效。安装只加入本机库，新代次从下一轮进入发现目录。后台任务继续持有依赖租约，确认退出之后才允许回收。启动恢复会清理已经退出的进程留下的租约。

索引只接受当前 v2 安装事实；旧版本或字段错误明确拒绝，不转换、不覆盖原文件。会话依据宿主采用的固定选择或按需加载模式装配环境。

## 示例与验证

`examples/skills/guided-review` 是纯说明目录；`semver-tools` 只安装标准 npm 包；`team-directory` 组合说明、资源和外部能力。后者的 service.json 由包作者填写实际组织目录端点，服务按 `q` 查询并返回 `[{"name":"…","email":"…"}]`。

平台验收位于 `packages/velaros/skills/spec/acceptance.test.ts`。Desktop 另有真实受限宿主的 npm 安装测试、后台任务租约测试、可信 IPC 与取消测试，以及空 PATH 的运行资源和 ASAR 执行测试。
