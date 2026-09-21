# 桌面控制不变量登记

每一条都是本单元对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；
新增一条同样要点名。

检验方式分五档，`check:module-ownership` 门会核对每一行的检验器是否真的存在：

| 检验方式 | 含义 | 检验器写法 |
| --- | --- | --- |
| 测试 | `spec/acceptance.test.ts` 里有以该编号开头的用例 | `spec/acceptance.test.ts` |
| 类型 | 由类型定义钉死，改不了 | `<文件路径>.ts::<类型名>` |
| 门禁 | 由仓库门禁脚本机械核对 | `check:<门名>` |
| 运行时 | 实现里有断言，违反即抛 `INVARIANT` | `impl/<文件>.ts` |
| 文字 | 目前只有文字描述，没有机器检验 | 留空 |

文字档在模块卡片的健康栏里显示为「未验证」，不算通过。编号只增不重排。

从工具面换到代码面（模型写程序、import `velaros:computer`）之后，INV-5（内核按工具名调用、入参用工具 schema 解析）与
INV-10（工具 schema 由源码生成）随工具面一起作废，编号不复用；模型面的承诺换成 INV-11 起的几条。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | `ensureAvailable` 永不抛：没装 helper、没权限、拉不起来都是结构化结果，`available` 为 false 且带得出原因 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 按截图坐标的移动与点击必须带同一次截图的 `snapshotId`：缺了在做事之前就被拒（`VALIDATION`），不降级成全局坐标、不猜屏幕几何、不去拉起 helper | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 显式全局坐标不许带 `snapshotId`：两种坐标空间是互斥的，混着传当场拒绝 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 坐标换算与绑定校验只在 helper 里发生一次：本单元把截图内坐标与绑定原样交下去，自己不按屏幕几何再算一遍；回执里 x、y 是模型给的那套，全局坐标另列 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 模型面只发布桌面控制真正需要的动作：截图、移动、点击、输入、按键五个；不发布「不看图拿屏幕几何」这类能被截图结果替代的操作 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | 释放之后的运行时不再有任何状态迁移：后续调用一律按 `sidecarDisposed` 拒绝 | 测试 | `spec/acceptance.test.ts` |
| INV-8 | helper 定位不联网、不装依赖：只认按需安装的平台包里的自包含 venv，找不到就判「未安装」 | 测试 | `spec/acceptance.test.ts` |
| INV-9 | 文件分工与对外边界不塌：五个操作在一个操作文件里、空间端口的每个方法都有操作在调；合同、类型、常量分开且接口成员有中文说明；实现一类一文件、类实现接口、按登记分层引用 | 门禁 | `check:module-ownership` |
| INV-11 | 模型面是 `velaros:computer`：声明从源码生成、只放出五个操作，随包发布的声明（`VelarComputerModule`）与生成物是同一份；模型写的程序照这份声明调到真实操作 | 测试 | `spec/acceptance.test.ts` |
| INV-12 | 截图经交图通道交给模型，返回值里只有几何与 `snapshotId`、没有图的字节；宿主没有交图通道时 screenshot 整个不可用，不去拉起 helper | 测试 | `spec/acceptance.test.ts` |
| INV-13 | 桌面控制不可用时每个动作都在做事之前拒绝（`PERMISSION`）：message 按原因引导用户（系统权限、插件没装），并明说不要自己用 pip 或命令装依赖 | 测试 | `spec/acceptance.test.ts` |
| INV-14 | 声明里写给模型的上限就是常量表 `ComputerInputLimits` 里的数：改常量不改说明（或反过来）过不了验收；超出上限的入参在做事之前拒绝 | 测试 | `spec/acceptance.test.ts` |
| INV-15 | 代码模版（`template.js`）是日常用法的示例程序（只是示例，模型按需要改写、不要求照着写），import 只写一次；它整份照生成的真实声明过类型检查，不嵌进声明，随模型面发布、按需读（`velaros:system` 的 modules.describe） | 测试 | `spec/acceptance.test.ts` |
