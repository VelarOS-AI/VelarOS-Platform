# 模型说明与请求材料

主请求的固定说明、程序、材料和图片由 Runtime 与 ProviderRequestCompiler 组装。宿主参数通过 inputs(sessionId) 冻结；能力用法通过 module template 按需发现；证据通过 ContextSourcePort 真实读取。模型可维护笔记和 observe 代码。

接入说明见 [对应运行合同](../../architecture/platform-runtime.md)；源码结构遵循 [模块规范](../../architecture/module-ownership.md)。
