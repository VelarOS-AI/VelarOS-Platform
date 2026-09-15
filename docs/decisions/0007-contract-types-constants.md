# 0007: 合同、类型、常量分开——`src/` 五目录再分类

- Status: accepted
- Date: 2026-09-15
- Owners: 模块所有权治理（`@velaros-ai/system`、`@velaros-ai/platform`）

## Context

ADR 0003 把包分成 `interface/`（provides、requires、internal）、`contract/`（数据）、`impl/`、`utils/`、`exports/`。用下来有三处名不副实：`interface/internal.ts` 里剩下的是带回调的内部选项，既不是对外合同也不是数据；`contract/system.ts` 把工具名表、错误码、环境变量表这些**值**和几百行数据**类型**挤在一个文件里；而真正对外的合同（产品面、注入面）反而不叫 contract。类实现的接口已经在上一步挪到类上方，`provides.ts` 里只剩没有类的公开接口。

## Decision

`src/` 仍是五个目录，但按"合同、类型、常量"重新分：

- `contract/` 只有三个文件：`provides.ts`（产品面：类实现的 API 定义在各自类的上方，这里 `export type { X } from '../impl/类文件.js'` 登记；没有类的公开接口直接声明在这里）、`requires.ts`（注入面）、`constants.ts`（约定的常量表：工具身份与类别、mod 与空间身份、错误码、环境变量表、公开的上限；只放 `Object.freeze` 的表、`as const` 的字符串身份和由它们派生的类型别名）。改这三个文件等于改对外契约。
- `types/` 只放类型，一个值都没有，按域分文件，只引 types 与合同。出不出包不看文件：合同签名的闭包用到的才从入口导出，实现自己的工作类型（写入计划、准备好的命令、清单印记、解析行、带回调的选项）自然留在包内。
- 可移植文件是 `types/<portable>` 与 `contract/constants.ts`，`./contracts` 入口就是这两个文件；可移植类型文件只许从常量表 import type，不带函数成员。
- 类实现的 API 一律定义在类上方（产品面的也一样），`provides.ts` 是登记表；门禁核对登记过的类上方接口都从根入口导出，公开签名只引合同、登记过的接口和公开数据。

`@velaros-ai/system` 与 `@velaros-ai/platform` 同日按此改完；对外入口路径与导出符号一个不变，产品壳不受影响。

## Alternatives

- 常量单开 `constants/` 目录：一个目录一个文件，违背"不拆碎文件"；常量表本就是对外承诺的一部分，放进合同目录更准确。
- 内部工作类型用 `*.internal.ts` 后缀或子目录标出来：合同签名的闭包已经决定了什么出包，再标一层是重复；目录扁平也是既定规则。
- 产品面接口继续集中在 `provides.ts`：和"类的接口写在类上方"矛盾，读类的人要翻两处；改成登记表后既保住"导出由合同控制"，又让接口紧挨着实现。

## Security and privacy

不涉及运行时行为。错误码、环境变量表、上限这些宿主赖以判断和配置的常量集中在一个文件，改动更显眼。

## Compatibility and migration

包内部改动，入口与符号不变，不需要迁移。对已治理包之外的代码无影响。

## Validation

`check:module-ownership` 按新规则核对两个包：合同目录只有三个文件、provides 的转发只许登记类上方接口、常量表只有冻结表与派生别名、types 零值、可移植文件不 import 不碰 Node 不带函数成员、导出的类型只来自合同与 types、公开签名不引 impl 与 utils。两个包的单测与验收、跨包语料、全仓 typecheck 通过。

## Consequences

新包按 contract / types / impl / utils / exports 五目录开工：先写 `contract/` 三个文件（API 定义在类上方，provides 登记），再写 `types/`，最后实现。
