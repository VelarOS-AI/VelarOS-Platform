# Changelog

## Unreleased

## 0.2.0 — 2026-09-16

- 按仓库模块结构标准改造：`src/` 收成 `contract` / `types` / `impl` / `utils` / `exports` 五个目录，
  九件整件能力各自一个类，API 定义在类上方并由 `contract/provides.ts` 登记。
- 入口从十个收成两个：`.` 与 `./contracts`。zod schema、`canonicalJson`、`sha256Json`、历史账等内部
  东西一律不出包；三个直接 `new` 的类改成工厂（`createDetectorRegistry` / `createVerifierRegistry`）
  或实例（`labDrivers`）。
- **Velar Hooks 驱动与客户端迁回宿主（Desktop）**：本包只带一个通用轮询驱动，认协议的驱动经
  `contract/requires.ts` 的 `LabDriverProvider` 与 `labDrivers.register` 注入。本包不再读
  `VELAR_HOOKS_*`，也不再读任何环境变量。
- 内置探测器不再写死任何产品的工具名：工具目录页与会向用户提问的工具由宿主注册时给名单
  （`registerBuiltins({ catalogToolNames, interactiveToolNames })`），不给就不出对应判词。
  探测器发现与看门狗中止从此共用同一份阈值与名单。
- 线格式的单一来源改成手写类型，`utils/wire/` 的 schema 逐个 `satisfies z.ZodType<…>` 对齐，删掉全部
  `as` 强转；枚举统一由 `contract/constants.ts` 的冻结表派生。
- 可执行入口移到包根 `bin/velaros-agent-lab.mjs`；`agentLabCli.run` 只返回退出码与两段文字，`src` 下
  不再有副作用，也不再有动态 `import()`。
- 探测器摘要、校验说明与 CLI 帮助改中文（命令、路径、错误码、字段名原样）。
- 包内三处重复实现收成单源：规范 JSON 一份（键按码点排序，不再跟区域设置走）、HTML 转义一份、原子写一份。

## 0.1.1 — 2026-09-06

- Add `RealTaskRecord`, deterministic outcome/health auditing, privacy-safe reports, and atomic real-task bundles.
- Add reviewed `RealTaskCase` promotion contracts for explicit single-case replay.
- Distinguish sequential feedback retries from redundant parallel failure fan-out.
- Extend the CLI with `validate real-task|case` and `audit-record`.

## 0.1.0

- Establish the public continuous-journey protocol, runner, driver contract, detector catalog,
  additive archive reader, deterministic report renderer, paired statistics, certification policy,
  and CLI.
- Historical compatibility exception: tool-call projections are deduplicated by `toolCallId` before
  per-leg accounting. Older Agent Lab reports could count cumulative projections repeatedly, including
  a known 1106-versus-69 inflation. Historical files remain untouched; new reports declare the corrected
  `unique-tool-call` measurement basis.
