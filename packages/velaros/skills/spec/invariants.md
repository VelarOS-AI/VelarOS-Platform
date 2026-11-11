# Skill 运行环境不变量

| 编号 | 承诺 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 纯说明与 npm 贡献安装为同一类包，失败不修改当前索引；标准安装器首装与锁文件恢复复制本地依赖，发布后仍可读取。 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 环境锁定安装代次，升级和卸载不破坏持有租约的文件。 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 安装不自动加载；能力授权只属于所选会话，卸载或升级阻止旧代次后续调用。 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 文件越界、清单损坏和内容篡改必须显式失败。 | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 不同 Skill 可以分别安装；同次选择的公开依赖和第三方能力入口冲突在环境装配时明确失败。 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 静态校验只读且不执行包代码；只有成功发布变更才通知订阅者；只接受当前安装索引 v2。模型管理与宿主确认由 Feature owner 提供。 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | 内置 Skill 与安装包共用选择和固定环境；宿主绑定缺失时失败，共用宿主能力逐次核对有效授权，专项 npm 包仅由所选 Skill 提供。 | 测试 | `spec/acceptance.test.ts` |
| INV-8 | 已退役：Registry 的 plugins 注入轨及插件内部 Skill 合并不再提供，产品 Feature 分发由宿主负责；编号不复用。 | 文字 | |
| INV-9 | SkillSession 经 catalog 发现、activate 按需加载、acquireRuntime 固定每次程序的依赖快照；未勾选也可加载，重复并发加载只保留一份活动项，安装状态消失或代次变化拒绝旧项，关闭不得复活授权。 | 测试 | `spec/acceptance.test.ts` |
| INV-10 | Feature 模块只能调用声明且获授权的宿主 SDK；派生调用沿用父身份、模式和取消，并经过 Kernel，禁止只读操作派发写入。 | 测试 | `spec/acceptance.test.ts` |
| INV-11 | 共用安装目录的多个执行会话可共用能力合同；宿主按真实调用身份提供独立 Skill 会话、租约和 Node 环境，准备阶段不激活其他会话，按需加载不污染其他会话的活动选择。 | 测试 | `spec/acceptance.test.ts` |
