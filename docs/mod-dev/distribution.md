# 分发：bundled、installed 与市场包

mod 到达用户设备的方式会改变其信任级、寻址方式和失败边界。本页只描述 Platform 的公开契约；
具体产品宿主必须单独公开自己的安装和更新策略。

## Bundled pack

bundled pack 是产品构建图中的普通依赖，不是运行时下载物。构建失败应在发布前暴露，运行时不再
动态解析它的代码来源。

Kernel 使用 `KernelBundledPack` 描述随包模块，`bundled:<moduleId>` 只是身份 URI，不能传给
动态 `import`。产品宿主静态导入能力包的 `create*KernelModule()`，再通过
`createBundledModPack` 和 `bootKernelDaemon({ modPacks })` 注入。Kernel 不应反向依赖具体产品能力。

Agent 使用 `assembleAgentMods` 装配 bundled pack。缺省包含
`createBuiltinAgentModPackage()`；宿主可传空数组显式关闭。bundled 先于 installed pack 注册，
但顺序只决定谁先占用稳定主键，冲突始终拒载，绝不以“后加载覆盖”处理。

## Installed pack

installed pack 至少包含一个目录和 `velaros.mod.json`。Platform 公开
`AgentModPackReader`、`AgentModHostProfile` 和 Loader 生命周期；产品宿主负责：

- 版本化寻址、注册表和原子写入；
- `readManifest` 与代码型贡献所需的 `loadBindings`；
- 启用、停用、升级、卸载和崩溃恢复；
- 信任级映射、签名验证、权限审批和用户可见诊断。

如果 reader 没有为 `tools` 或 `hooks` 返回绑定，Loader 会以 `mod.binding-missing` 拒载，
不会把代码型贡献降级成空实现。停用只移除运行态贡献；数据删除必须是独立、明确确认的步骤。

## 市场分发

`marketplace-signed` 只有在宿主完成以下闭环后才可用：

1. 发布方私钥签名和应用内置公钥验证；
2. 精确版本与摘要寻址，禁止 latest-only；
3. 吊销、原子安装、失败回滚和可恢复升级；
4. 权限声明与实际能力 broker 的一致验证；
5. 可审计的发布者身份和安全响应渠道。

单独的 SHA-256 只能发现传输损坏，不能证明发布者身份。在完整闭环落地前，宿主必须对
`marketplace-signed` fail closed。

## 整合包

整合包应是精确列出成员、版本、摘要和顺序的 lockfile，不是运行时依赖求解器。冲突由整合包
作者在发布时解决，运行时只按确定顺序平铺装载，并沿用普通 pack 的主键冲突规则。

## 认证与测试

公开分发至少需要：

- schema、架构边界、权限和打包内容的机械检查；
- 对 bundled pack 的持续集成和真实运行场景；
- 对外部 pack 的隔离审核与抽样执行；
- 明确记录未测试的宿主、平台和能力范围。

执行第三方 pack 自带的测试代码等同于执行第三方代码，必须在隔离环境中进行，不能继承发布机
凭据，也不能拥有自动批准敏感操作的权限。
