# 桌面控制不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；
新增一条同样要点名。

检验方式分五档，`check:module-ownership` 门会核对每一行的检验器是否真的存在：

| 检验方式 | 含义 | 检验器写法 |
| --- | --- | --- |
| 测试 | `spec/acceptance.test.ts` 里有以该编号开头的用例 | `spec/acceptance.test.ts` |
| 类型 | 由类型定义钉死，改不了 | `src/<文件路径>.ts::<类型名>` |
| 门禁 | 由仓库门禁脚本机械核对 | `check:<门名>` |
| 运行时 | 实现里有断言，违反即抛 `INVARIANT` | `src/impl/<文件>.ts` |
| 文字 | 目前只有文字描述，没有机器检验 | 留空 |

文字档在模块卡片的健康栏里显示为「未验证」，不算通过。编号只增不重排。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | `ensureAvailable` 永不抛：没装 helper、没权限、拉不起来都是结构化结果，`available` 为 false 且带得出原因 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 主屏局部坐标的移动与点击必须带同一次截图的 `snapshotId`：缺了在入参门就被拒，不降级成全局坐标、不猜屏幕几何 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 显式全局坐标不许带 `snapshotId`：两种坐标空间是互斥的，混着传当场拒绝 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 坐标换算与绑定校验只在 helper 里发生一次：本包把截图内坐标与绑定原样交下去，自己不按屏幕几何再算一遍 | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 内核操作名就是工具名，入参用工具自己的 schema 严格解析；没有第二份手写的入参门 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 模型面只发布桌面控制真正需要的动作：不发布「不看图拿屏幕几何」这类能被截图结果替代的工具 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | 释放之后的运行时不再有任何状态迁移：后续调用一律按 `sidecarDisposed` 拒绝 | 测试 | `spec/acceptance.test.ts` |
| INV-8 | helper 定位不联网、不装依赖：只认按需安装的平台包里的自包含 venv，找不到就判「未安装」 | 测试 | `spec/acceptance.test.ts` |
| INV-9 | 文件分工与对外边界不塌：五个工具的定义在一个工具文件里；合同、类型、常量分开且接口成员有中文说明；实现一类一文件、类实现接口、按登记分层引用；utils 只放带中文说明的函数与常量；对外入口只转发，类、utils 函数、内部接口不出包；环境变量全部登记；渲染进程可加载的入口不碰 Node 内置模块 | 门禁 | `check:module-ownership` |
| INV-10 | 五个工具的 schema 可由源码机械生成，工具名与宿主登记的归属一致 | 门禁 | `check:capabilities-schemas` |
