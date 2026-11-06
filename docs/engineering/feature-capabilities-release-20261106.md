# Feature 能力与核心运行环境

本次统一包版本为 `@velaros-ai/velaros@0.7.0`，发布 tag 为 `v0.6.111`。Kernel `0.7.0`、Script `0.4.0` 与 JsTs `0.2.0` 随统一包交付，平台兼容代仍为 `0.6`。

Feature 合同统一产品说明、操作知识、npm 依赖与实现模块。模块通过声明的宿主 SDK 派生调用，沿用父调用身份、执行模式与取消，并重新经过 Kernel 授权；只读操作不能转发写入。旧 Skill 注册处继续维护不可变安装、环境快照与租约。

基础 Node 环境只保留 execa、@vscode/ripgrep、globby 与 diff，文件和 JSON 使用标准库。其他非必要预装依赖已从 Script 删除；模块保留自己的实际依赖。TypeScript 与 ts-morph 由 JsTs 按需提供，从下一次程序执行生效。

Computer Use 扩展窗口与控件查询、键鼠状态、滚动拖拽和有界录像；Python 运行资源与第三方许可随对应平台分发。执行、取消、输出上限和坐标身份继续由宿主核对。

公开合同变更包括新增 features 入口、可声明的宿主 SDK、Kernel 派生调用上下文以及 Computer Use 操作；默认 npm 清单的缩减属于执行环境行为变化，消费者应使用对应能力或声明自己的依赖。Desktop 与 UI 的 Feature 迁移需要消费本次新发布包。
