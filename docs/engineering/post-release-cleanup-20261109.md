# 0.9.2 后的模块清理差量

正式 0.9.2 继续固定在 `v0.7.3` / `ae20dcebf5d086d99ff7d8df1701d71a91574efe`，本批为后续开发源码，不改包版本或归档。活跃源码已包含全部发行修复；原工作区保留用户未暂存的空行差异，独立发行格式提交没有进入原索引。

| 范围 | 实际问题与修改 | 原承诺及影响 |
| --- | --- | --- |
| memory | 标签小写可能增加字符数；规整后再核同一 tagChars，同时保留原输入核对。 | 恢复 INV-4/6 的写后可读和非法输入零写入，合法边界仍可往返。 |
| core/path-rules | repository 子根原先只查本地规则；现在先采用注入 Git 的确定结论，null 才走已有本地降级。 | 恢复 INV-5/6 的 Git 权威与已忽略根整次豁免，不可用缓存保持一次探测。 |
| images | 裁缩回调被取出后失去端口接收者；将捕获的方法绑定回原端口。 | 恢复 INV-2 的合法有状态宿主缩图能力，尺寸、格式与容量算法不变。 |
| images | externalEdit 漏出底层错误码；仅该已知码映射为 VALIDATION 和展示路径重试提示。 | 恢复 INV-6 的通用读图错误，未知 AppError 原对象保留，绝对目标路径不进入该提示。 |
| web | mailto/file/tel 等无双斜杠或数字载荷被误补成 HTTPS；显式 scheme 先核验，仅明确裸域/localhost 数字端口允许补协议。 | 恢复 INV-12 的非法协议零开页，保留裸域端口、localhost、IPv6 和原无协议网页。 |
| sandbox | finally 的暂存删除失败覆盖已完成/部分完成的写入事实及原错误。 | 恢复 INV-14/15：保留 context.applied/executionOutcome、原失败 cause，并附 cleanupError/stagingDirectory；文案不再错误暗示全提交后还有未写路径。 |

操作签名、模型声明、效果声明与存储格式未改变；实现恢复既有承诺，不生成新的模型协议或能力版本。有明确用途的搜索退避、编码选择、权限恢复、跨挂载点替换及宿主委派继续保留。

六个定向回归全部通过：Memory INV-6、IgnorePolicy 新 INV-5/6、Images 有状态缩图/读取边界、Web INV-12、Sandbox 一次隔离子进程内的全部/部分提交后清理失败。没有真实浏览器、桌面输入、隔离后端、供应商或旧全链重跑。改动 lint、Core/Velaros 无输出类型检查及两包全部治理单元的 check:module-ownership 通过；统一格式化核对用户文件 SHA256 与原索引保持原样。

语义覆盖另列，不能用静态门替代。Skills 共享 host/SDK owner 仍需结合模型入口 moduleAccess 与底层派发核证，未采用会误拒合法 SDK 调用的一行过滤方案；Office、Computer 和高级搜索的新候选另批处理。
