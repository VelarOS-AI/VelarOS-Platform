# 语义清理正式发行 0.9.6

更新：本次源码修复与资产身份保留；随后按用户“正式无 override”规则做成对普通安装时发现 base peer 会请求 registry 并 404。该成对接入由 [0.9.7 的发行依赖根修](plain-dependency-release-20261110.md) 替代，旧归档不改写；不能把 0.9.6 的基础单包消费证明当作成对普通安装已通过。

根据完成后合并、推送并让产品接入最新正式版本的指示，本轮清理分支合入 main，以火车标签 `v0.7.7` 发行基础 `@velaros-ai/velaros@0.9.6` 与能力 `@velaros-ai/capabilities@0.9.6`。平台代仍为 `0.7`，原 0.9.5 的资产和内容身份保留，不覆盖旧版本。

本轮全部源码修复见 [最后一批差量](semantic-resource-cleanup-20261110.md) 与 [26 模块覆盖](semantic-review-coverage-20261110.md)，之前各批报告与提交同样进入 main。已有 53 个定向场景、各包构建/类型与门禁绿项保留；此次只新增发行版本、锁文件、生成目录与正式源码/归档身份所需检查，不扩审查或运行重型全套。

源码包按独立 SemVer 递增补丁：core 0.4.5、kernel 0.7.2、context 0.12.1、model 0.10.7、agent 10.1.2、agent-lab 0.2.1、velaros 0.9.6。ProjectPackageVersion 与 AgentLabPackageVersion 同步各自包版本，仅改变版本元数据。未变的 script 与 skill-jsts 版本不动。agent-lab 的修复和版本随源码交付；它仍是独立工具包，不冒充基础/能力归档内容。

公开操作签名、效果、模式及上限无新变化。0.9.6 当时的能力包精确 peer 已由后续实际普通安装证实不能满足新规则；正式依赖以 0.9.7 的 canonical 普通来源合同为准，不写 overrides/resolutions，开发覆盖不构成生产要求。Windows 打开规格改为系统 PowerShell，Project definition 不再伪签独立读取版本，Runtime 基础故障保留原错，以及新任务输入归属等行为差量已在模块 README 与差量报告明确。Office XML 依赖只属于能力归档闭包。

正式发布沿用 `release-packages.yml` 与安全发布器：固定 tag/HEAD、冻结安装、现有五分钟质量检查内的新构建、安全独占临时目录打包、同字节 SHA-256/SHA-512、基础归档独立 JS 与严格声明消费、draft 完整上传后公布。所有最终 URL、sourceSha、integrity 和 SHA-256 以 Release 的 `release-manifest.json` 为单源，归档验证见 `release-validation.json`。不把确定性消费测试声明为供应商连通或跨 OS 全路径验收。

原 D 工作区、用户文件与 index 不参与合并或发布操作。分支清理在 main 推送及正式发布完成后进行；在用且有未提交用户改动的分支保留并向协调报告具体阻碍，不 reset 或 stash 用户数据。
