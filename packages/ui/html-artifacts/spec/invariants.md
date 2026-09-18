# HTML 制品不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；新增一条同样要点名。
检验方式与 `packages/agent/spec/invariants.md` 相同：测试 / 类型 / 门禁 / 运行时 / 文字，`check:module-ownership` 核对每一行的检验器是否存在。

编号只增不重排。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 流可以在任意字符处切开：chunk 断在半个标签、半条 CSS 规则、半段 Base64 里都不会把残片送进 iframe，只有完整、安全的协议边界才发事件；认不出的协议版本整段原样当 Markdown | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 沙箱边界不靠自觉：iframe 固定 `sandbox="allow-scripts"`，外链只放行 `http:` / `https:`，非法或主动执行型 URL 永远到不了 `onLink`，只经 `onError` 的 `security` 档报出来 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 上报高度是去重后的绝对值：宿主直接应用、不加 padding，`maxHeight` 在 iframe 内部与浏览器宿主两侧都封顶，超高内容留在沙箱里滚 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 协议资源上限对超长或恶意流生效：缓冲区、制品 HTML、协议原文、补丁载荷四项按 `HtmlArtifactProtocolLimitDefaults` 兜底，宿主可以逐项收紧 | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 注入 iframe 的脚本不另抄常量：缺省高度上限与宽度倍数上限就是 `HtmlArtifactDefaults` 里那两个数字，改常量表脚本跟着变 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 两个入口整条引用链不碰 Node 内置模块，浏览器扩展与渲染进程都能直接加载；类与工具函数不出包，外面只拿得到三件能力的实例、工厂与常量表 | 门禁 | `check:module-ownership` |
| INV-7 | 解析状态是纯数据：宿主可以自己把 `HtmlArtifactProtocolStreamState` 存下来、换个进程再喂 chunk 续读，状态里没有函数、没有类实例 | 类型 | `types/html-artifacts.ts::HtmlArtifactProtocolStreamState` |
