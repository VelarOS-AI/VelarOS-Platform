# 模块结构与所有权

模块登记在 `scripts/ownership/governed-modules.mjs`。该表决定源码根、布局、模型能力入口、实现层级、运行环境、资产和验收位置；包清单决定真实宿主导出。`check-module-ownership.mjs` 对全部登记模块执行同一套结构、分层与合同检查。新增或修改模块时，先读该模块登记与 MODULE.md，再修改其责任范围。

## 源码根与统一布局

| 模块 | 源码根 | 布局 |
| --- | --- | --- |
| 普通治理包，如 Agent、Context、Kernel、Model、Script、Agent Lab | `packages/<包>/src/` | contract / types / impl / utils |
| Core 底层单元、Velaros 能力单元 | `packages/<包>/<unit>/` | contract / types / impl / utils |
| Act 主干与职责组 | `packages/velaros/act/{runtime,system,search,agents}/` | contract / types / impl / utils |

Core 的 `src/` 基础原语遵守其包级检查；Core 的 platform/text-files/path-rules 按单元登记。不要把某个治理单元的目录限制套到整个包。

**一个文件一个职责。** 默认保持扁平。types/impl/utils 文件多时可按域分组，每个子目录至少直接包含三个源文件，不增加只包子目录的空层。登记的 types/utils 也可直接指向文件，例如 Act search 的 `types.ts` 和 `tuning.ts`。contract 保持扁平。

## 统一布局：contract / types / impl / utils

```text
<源码根>/
  index.ts                  宿主入口，只转发
  contracts.ts              可移植数据入口，按包清单配置
  contract/
    provides.ts             产品面声明及类上方 API 的登记
    requires.ts             宿主注入面
    constants.ts            公开身份、错误码、环境变量与上限
    surface.ts              代码面能力的生成合同（适用时）
  types/                    纯类型；也可登记为单文件
  impl/                     同名类、接口、实例与公开工厂
  utils/                    纯函数、规则常量与登记的 tuning
```

- provides/requires 只有带中文说明的类型声明或允许的类型转发，每个接口成员有说明。类 API 写在同一实现文件的类上方，公开 API 通过 provides 登记；构造参数等配套接口以类名开头。其他数据与内部工作类型进入 types。
- constants 只放冻结常量表、字符串身份及由常量派生的类型。`surface.ts` 由 `scripts/script/generate-declarations.mjs` 生成，不能手改。
- types 不含运行时值，只使用类型导入，依赖类型与合同。公开签名用到的类型导出；内部工作类型保持内部。登记的 portable 数据文件不带函数成员、Node 专属类型或运行时依赖；可按检查器允许的形式引用 constants 派生类型。
- 一个实现类一个文件，文件名与类名一致；类 implements 对应接口，公开成员不得超出接口，不暴露公开静态成员。私有方法用于实例相关逻辑，纯函数进 utils。Error 类按门禁的错误类规则处理，并通过错误码对外表达。
- 实现文件只声明本类接口及配套接口，模块级函数限公开工厂。全局唯一实例按公开接口标注类型。utils 不声明类或类型，不保存可变全局状态；函数上方写一句中文说明，只依赖 utils、数据与合同。

## 模型能力定义与装配

需要分清四件事：源码归属、宿主 API、模型模块名和当前会话装配。

| 责任 | 当前接入位置 |
| --- | --- |
| 领域能力，如 files/project/browser | 单元的操作接口与实现；登记 `surfaceFile` 和 `hostPort`，生成配置在 `scripts/script/surfaces.mjs` |
| Act 模型操作 | system/search/agents 的 `impl/*Operations.ts` 操作接口是模型面来源（生成 `contract/surface.ts`），`impl/*Module.ts` 只把生成的模型面与实现绑成 Kernel 模块；职责组根目录保存模板 |
| 模型自管理空间 | `act/system`；模型从 `velaros:system` 导入 modules/memory/store |
| 会话与主干装配 | `act/runtime` 的 RuntimeBootstrap、ComposedRuntime、StandardModules |
| 宿主入口 | package.json exports；如 `@velaros-ai/velaros` 和 `@velaros-ai/velaros/act/system` |
| 实际可发现能力 | Runtime 按会话种类、宿主配置与授权生成包映射及目录 |

能力定义、模板和发现必须对应同一份实际操作合同。模型使用 `modules.describe` 获取声明及 template；模板是按需使用的示例，不自动当作常驻上下文。

领域能力与 Act 的声明和派生 schema 都经 `generate:script` 从操作接口生成并由 `check:script` 校验。Act 模型目录由登记表与构建后的生成模型面写出，使用 `generate:act-catalog` / `check:act-catalog`，清单在 [Act 能力目录](../../packages/velaros/act/README.md)。修改实际操作定义后先构建所属包，再生成依赖该构建的目录。

若登记项包含 toolsFile/toolDefiner，该模块的工具定义、分组和挂载集中在指定文件，定义函数只在那里调用，复杂处理委托实现类。这个检查只适用于有相应登记的模块；领域操作表与 Act 操作模块按各自正式定义位置维护。

## 实现分层与注入

每个实现文件必须登记 layers。列表由上至下，上层可引用同层与下层，下层不得引用上层；以 `/` 结尾的项登记整个子目录。utils 位于实现层以下。模块间通过公开入口引用；同一包内已治理单元的数据与纯工具复用仍按检查器的目标层边界核验。

宿主注入集中在 requires。环境变量也属于注入：本仓自定义名称使用 `VELAROS_`，登记在该模块常量表的 environmentTable；读取第三方变量时由 environmentPrefixes 扩大检查范围，登记项与源码用途一致。

依赖使用文件头静态导入，不写内联 import 类型。源码动态 import 仅允许登记在 lazyImports 中的固定目标、唯一加载文件与用途说明；登记项必须有实际使用。进程启动壳按 bin 的运行边界处理。按需加载 Node 内置模块仍属于 Node 适配器，不能进入 browserSafeEntries。

## 常量与参数

| 种类 | 位置 |
| --- | --- |
| 公开身份、错误码、环境变量、合同上限 | contract/constants.ts |
| 包内超时、缓冲、窗口等可调数字 | 登记的 tuning 冻结表，每项有中文说明且实际使用 |
| 类内固定文案、模式、名单 | 类的 private static readonly |
| 规则名单、格式与算法常量 | 对应 utils；非显然的算法数字附说明 |

同一参数由一处定义。公开上限放在常量表，`@AgentView` 文档写的数字与入参核对都引它，验收核对两边一致，避免模型看到的限制和执行限制不同。

## 入口、运行环境与资产

入口只转发。导出范围由产品面、注入面及其数据闭包决定；实现类、utils 函数及内部接口不作为公开 API。值导出来自常量表或显式标注公开接口的实例/工厂。公开签名使用的数据必须导出，导出的数据也必须有公开用途。

- 普通包：`src/index.ts` 对应 `.`，`src/<名>.ts` 对应 `./<名>`，输出为 dist 下的同名文件。
- 能力单元：源码根直接为 unit，子路径一般为 `./<unit>` 及其运行环境入口，输出到 `dist/<unit>/`。
- `packageEntry: true`：单元承载包根入口；当前 Velaros 的 `.` 映射到 `dist/act/runtime/index.js`。以清单中的完整映射为准。
- 新增子路径必须由独立能力单元或运行环境边界支撑，不能为同一职责堆叠入口。可移植数据与 Node 本机适配器分别在 contracts/local/node/renderer 等已声明入口发布。
- browserSafeEntries 的整条值依赖链不能加载 Node 内置模块；名字叫 contracts 或 renderer 并不自动证明可在浏览器运行。
- 单元旁的 MODULE.md、模板、spec/test 和登记的 assets 属于说明、验收或分发资产；资产须进入 package.json files，不能混入源码层级。
- 可执行入口在包根 bin，清单登记目标、shebang 和分发文件。启动壳只转交进程参数及环境，业务行为由包内能力承担。

## 验收与差量报告

MODULE.md 说明模块职责、公开面、链路、依赖、状态、生命周期、失败、不变量及结构；invariants 为承诺指定真实检验器。包的 test 脚本必须执行登记的验收，文档条数与实际登记一致。

修改 provides/requires、公开常量、模型操作或模板时，差量报告逐项写明理由、影响和验证。改变既有验收承诺必须解释，不能通过删测让门禁变绿。文档更新也应说明更新范围与仍待完成的行为。

最低结构检查是 `bun run check:module-ownership`；根据修改范围补充生成声明、模板目录、类型、构建与行为测试。历史设计、差量报告和评测快照保留其当时的证据，当前接入以本规范、模块卡片、真实导出和可执行验收为准。
