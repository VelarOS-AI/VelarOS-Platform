# Platform 基础与能力发行

平台代 `0.7` 使用两个安装身份：`@velaros-ai/velaros` 提供基础 Runtime，`@velaros-ai/capabilities` 显式提供专项能力。两包同版发行；能力包通过普通必需依赖固定到同一 tag 的官方基础归档，不通过 registry-only peer 找基础，也不内嵌 Kernel、Agent、Context。源码包拓扑与安装边界分别管理，发行单元单源为 `scripts/release/platform-distributions.mjs`。

## 接入合同

基础保留根、contracts、renderer、node、execution、memory、act/system、act/search、act/agents 及原 core/kernel/model/agent/context/script 的公开子路径。专项单元 features/images/sandbox/project/computer/office/browser/web/sessions/skills/act/bridge 与 skill-jsts 资源只进入能力包；没有旧专项入口别名。确切签名、删除项、宿主与资源所有权见 [ADR 0028](../decisions/0028-runtime-foundation-and-capability-distributions.md)。

每个归档只复制登记的单元、资源与必要声明。AST 核对 JS、声明和跨单元模块引用；扩展只能经基础公开入口访问，基础引用扩展会拒绝发行。第三方依赖按实际引用及真实运行发现清单计算，核对安装版本和源码范围后固定版本。专项 vendor、二进制和 resources 不进入基础，也不靠 optionalDependencies 隐藏体积。

同时装配基础与能力的正式产品在普通 dependencies 中固定两份 canonical Release URL，能力包内部对基础使用同一个 URL。正式发版不写 overrides/resolutions；开发覆盖不能成为生产安装或共享实例的前提。Bun 把 file 与 HTTPS 视为不同来源，即使归档字节相同也可能另装基础；成对生产依赖不混用这两种身份。本地缓存可用于校验或恢复下载，不代替 canonical 依赖声明。仅使用基础的产品不涉及该共享解析边界。升级同步两份依赖来源与锁文件 integrity，并核对实际唯一基础实例。完整接入规则见 ADR 0028。

## 所有权与验证

公开合同仍归模块 provides/requires、源码 exports 与 governed-modules。发行器派生各安装身份的入口并剔除开发 overrides/resolutions；基础和扩展继续使用 safe-package-pack 的独占临时目录、超时、进程组回收和路径边界检查。正式发布的整列 tag 同时产出两种固定身份；消费者独立选择安装清单。

为验证指向本 tag 的真实依赖，发布器先完整上传待验归档，再将候选设为 prerelease 且 non-latest，使 canonical URL 可下载；实际两份归档必须通过无覆盖普通安装、冻结安装、源码摘要与锁来源、唯一基础实例、严格声明和真实项目事务验证，收据上传并再次核对后才晋升 stable/latest。失败尝试恢复 draft，不宣称正式成功；原归档不换成本地改写元数据。

本批仅做一次集中验证：源码构建、必要静态门及最小实际归档消费者。`bun run check:unified-platform` 对基础和扩展各打包一次；先只安装基础，独立执行 JS 与 skipLibCheck:false 声明消费，再安装显式项目扩展，在同一 Runtime 上执行真实文件事务。基础消费者经过输入、确定性 ModelDriver、真实命令和文件、交互、取消及跨 Runtime 恢复；确定性驱动不证明供应商 API 可达性。receipt.json 记录宿主平台、真实来源、压缩和安装体积；Windows 结果不能代替干净 Linux。

临时验收归档只交接固定路径和 SHA256，不自动更新产品仓依赖或远端发布。Linux 验收由只读 CI/隔离环境运行同一最小消费者，供应商 API 验证需明确测试凭据与隔离目标，不在用户生产服务上执行。
