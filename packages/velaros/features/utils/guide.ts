/** 产品能力的最小创作格式与兼容导入边界，正文只在显式查询时返回。 */
export const featureGuide = `Feature 是可安装的能力单元。Skill 是内部操作知识，模块与 npm 是实现。
本机目录使用 feature.json：schemaVersion 为 1，id 为稳定包名，name 为展示名称，description 为用途，version 为语义版本。
prompt 是用户选择后附加到当前任务的要求；instructions 是包内 Markdown 路径；implicit 控制是否允许自动调用。
代码贡献写在可选 runtime：packages 公开 npm 包名，modules 列出 {module,entry,contract}，hostCapabilities 由宿主绑定给模型，sdkCapabilities 允许模块代码通过 velaros:host 调用宿主。
npm 依赖继续写在标准 package.json 的 dependencies。模块合同使用自包含具名函数声明，效果使用 @OperationEffect none 或 write，写操作加 @OperationModes execute。
模块名可使用 feature: 前缀。模块实现可接受第二个宿主参数 context，调用 context.host.invoke({module,operation,input})；该通道只允许 sdkCapabilities 中明确声明且当前获授权的模块，每次调用经过 Kernel。
也可以导入传统 SKILL.md 目录、Codex Skill 或单个 Markdown 文件。Codex agents/openai.yaml 的展示名称、简介、默认提示词、allow_implicit_invocation 会映射为能力属性。工具依赖保留为配置需求，不自动连接服务。
只读取与任务相关的说明；说明不扩大用户任务或权限。先 validate({path}) 做静态核验，再 install({path})。安装发布由宿主确认，依赖安装脚本默认关闭。
load({id}) 返回操作说明与资源目录；新增 npm 从下一次程序执行生效。升级、停用或卸载后，旧代次不能继续调用。`
