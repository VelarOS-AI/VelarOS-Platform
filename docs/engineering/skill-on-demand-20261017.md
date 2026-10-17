# Skill 按需加载差量

## 合同与行为

新增 `createSkillSession`、`SkillSessionApi` 和 `SkillSessionOptions`。会话目录提供已安装 Skill 的用途；只有工作区默认项、显式选择及模型实际加载的项进入依赖环境。固定选择租约保留原有语义，宿主通过可选 `session` 接口启用按需模式。

`SkillsOperationContext.session` 让模型直接加载目录中的 Skill，不再要求用户先勾选。`SkillCapabilityModuleOptions.session` 在能力调用前启用对应依赖，并继续核对安装代次与权限。项目语言能力沿用相同的加载与撤权规则。

新加载的 npm 包从下一次程序执行开始使用；当前执行的快照保持固定。旧快照与后台任务共享会话所有者，全部执行收束后统一释放。失败加载不改变当前环境，也不阻止后续加载；重复并发加载合并。

新增 INV-9 验证按需加载、去重、快照与撤权。INV-5 增加未加载依赖冲突不会阻断空会话，以及冲突后已加载环境继续可用的验证。原有固定选择验收承诺保持不变。

## Windows 验证

声明生成器统一路径分隔符及源码、模板、基线换行；模块所有权检查统一路径和文本换行。LF 与 CRLF 生成内容一致，并验证 CRLF 检出的基线可通过检查。

- Velaros 依赖闭包构建、Velaros 类型检查、模块所有权及代码规范检查通过。
- 新增按需加载与依赖冲突测试通过；声明生成器的 Windows 路径和换行回归通过。
- Desktop 的真实 Node 集成验证覆盖三种工作区的浏览器调用、默认项去重、未勾选第三方 Skill 的说明加载、npm 导入和能力执行，共 8 项通过。
- 本机完整 Skill Bun 测试曾有 17 项通过、5 项失败；失败涉及 Windows 命名管道监听 ENOENT，不能将其记录为完整通过。对应运行链路另由 Desktop 的 Node 集成测试验证。

本次交付 Velaros 0.6.4 的 Desktop 固定依赖快照，Platform 快照版本为 0.6.62。
