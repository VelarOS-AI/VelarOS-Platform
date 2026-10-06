# 默认 Node 环境依赖与发布门禁修复

本轮修复 `cf77f16a` 交付时的依赖安全与公开资料门禁。执行合同保持单一 Node `exec`，默认包为 Execa、ripgrep、globby、diff 和 yaml；修改集中在依赖版本、安全补丁、分发验证和历史报告的路径规范化。

## 依赖修复

| 依赖 | 当前锁定版本或处理 | 验证方式 |
| --- | --- | --- |
| brace-expansion | 1.1.21、2.1.7、5.0.12，各自保持原大版本 | 锁文件与 audit |
| Electron | 41.10.7 | 构建、浏览器与现有运行回归 |
| fast-uri | 3.1.8 | 依赖门禁与完整回归 |
| ip-address | 10.7.3 | 依赖门禁与完整回归 |
| proxy-addr | 2.0.8 | 依赖门禁与完整回归 |
| undici | 7.30.0 | 依赖门禁与完整回归 |
| argparse | 2.0.1；Mammoth 使用兼容接口，闭包不含 sprintf-js | 实际 CLI 帮助、无效参数、DOCX 转 HTML、Office 回归与独立消费者 |
| braces | 3.0.3 加入 128 层分组深度上限 | 补丁及文件哈希、正常与恶意输入、globby 三类 API、独立安装与 Desktop 资源验证 |

同一轮原始 audit 的条目数从 31 降至 2。剩余版本告警是已核验本地补丁的 braces 和沿用既有仅调用 v4 检查的 uuid。`check:dependency-security` 先强制核验实际依赖图、源码哈希与行为，再应用这两个有依据的审计例外；原始 audit 并非零告警。策略与退场条件见 [dependency-security.md](dependency-security.md)。

braces 防护在底层解析器与 compile、expand、stringify 的递归入口生效，超过限制抛出 SyntaxError。正常范围、嵌套选择、转义字面量、Unicode 文件名与排除匹配继续成立。测试同时覆盖 128 层边界、129/4000 层输入、手写深层 AST，以及篡改补丁后核验失败。

## 安装与分发

源码安装由 Bun `patchedDependencies` 应用补丁，`.gitattributes` 固定补丁文件为 LF。检查器沿真实模块解析路径遍历，能发现锁文件升级后实际链接仍指向旧包的情况。

Script 的 `bundledDependencies` 声明 globby，Velaros 声明 Mammoth。安全 packer 在独占临时目录中复制当前安装的实际生产依赖闭包，保持嵌套版本、许可证和源码字节；将 workspace 协议转换成发布版本，然后沿现有超时、进程组回收和路径边界流程打包。普通未声明 bundle 的依赖仍按包清单安装。

这一暂存步骤修复 Bun 1.3.13 从 workspace 链接打包时遗漏已声明 bundle 的问题。真实 tarball 测试覆盖版本覆盖、循环依赖、与 Node 内置模块同名的 npm 包、workspace 版本转换、源文件和链接保持完整，以及包中只携带所声明的依赖闭包。官方发布器与验证器复用相同 packer。

独立消费者先安装真实 tarball，再检查所有可达 braces 副本的补丁哈希与行为，以及 sprintf-js 的缺席；随后验证 NodeNext 类型、浏览器安全入口、默认五包、Act 执行、持久存储、取消、重开与项目语言能力。Desktop 的资源门使用应用携带的 Node 执行过深 globby 模式，确保发行资源里的补丁也生效。

## 历史报告路径规范化

两份 2026-10-04 JSON 报告只把本机 home 前缀替换为 `${USER_HOME}/`。long-runtime 报告替换 341 处，native-tools 报告替换 8 处。将占位符还原后与 `cf77f16a` 中的原文件逐字一致，JSON 数据也一致；测试成绩、失败、成本、耗时与任务身份字段保持原值。本轮没有重新运行模型评测。

| 报告 | 原始 SHA-256（Git `cf77f16a`） | 规范化后 SHA-256 |
| --- | --- | --- |
| scriptact-long-runtime-results-20261004.json | 9399e60cc3d9d5b25b80a9533c6fae957c27e3dc6b6d5b40b4d545b7f91f3152 | 3677beef92aa9f01838a032617d01b0f422f149bc85568759da5f43bc134fead |
| scriptact-native-tools-results-20261004.json | 8b039854e657139dccfeb3ca404d99ed8869bfe81de3ec815fcc864b29e82b2d | f4f11d7b09e1e86cc334c49c4bd2973d7221a25abeede856913465cc17dd87a6 |

## 验证

- 依赖安全定向测试 4 项、安全打包测试 13 项通过。
- 安全门禁、公开资料门禁与真实 tarball 独立消费者通过。
- Desktop 默认资源测试与真实 Electron ASAR 执行验证通过。
- Platform 完整 `bun run check` 通过，包含全包构建、类型、Lint、格式、回归与全部门禁。Velaros 能力组 1250 项通过、6 项平台条件跳过；Runtime/Act 894 项全部通过。
- Desktop 完整 `bun run check` 通过，四个类型分区顺序通过；全仓检查保留一条既有可选类型写法提示，错误数为 0。

本轮收益是安全修复随源码安装和产品分发到达实际消费者，并补齐失败可见的持续检查。模型正确率、总费用和整题耗时仍以独立评测为准。
