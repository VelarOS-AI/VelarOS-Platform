# @velaros-ai/browser/tools

> `@velaros-ai/browser` 的一个导入切片(`packages/browser/src/tools`)。包总览见
> [包 README](../../README.md)。

## 这个切片是什么

面向 agent 的**浏览器工具定义**:工具名、zod 输入 schema、能力声明、工具上下文契约,
以及浏览器 recipe(可复跑的操作序列)。

工具经 `ToolBrowserApi` 调用宿主的浏览器,**不直接依赖 Electron**,
所以同一套工具可以跑在内嵌 WebView 上,也可以跑在外部 CDP 浏览器、Playwright 或自研 runtime 上。

## 公共入口

- `@velaros-ai/browser/tools`

## 工具面覆盖什么

六十余个工具,分这些族:

| 族                 | 代表工具                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| 会话与站点         | `browser:enter_site` / `browser:leave_site` / `browser:site_context` / `browser:show_page` / `browser:switch_page_target`               |
| 检查               | `browser:inspect_page` / `browser:read_page_data` / `browser:query_elements` / `browser:observe_actions` / `browser:get_element_bounds` |
| 交互               | `browser:act` / `browser:click_coordinates` / `browser:type_text` / `browser:press_key` / `browser:scroll_page`                         |
| 等待               | `browser:wait_for_page` / `browser:wait_for_selector` / `browser:wait_for_pending_event`                                                |
| 页面数据与抽取     | `browser:extract` / `browser:extract_table` / `browser:extract_list` / `browser:paginate_extract` / `browser:read_page_storage`         |
| 网络与诊断         | `browser:list_network_events` / `browser:get_network_response_body` / `browser:list_console_events` / `browser:list_page_errors`        |
| 挂起事件           | `browser:handle_dialog` / `browser:handle_download` / `browser:handle_permission` / `browser:list_pending_events`                       |
| 截图 / 录屏 / 导出 | `browser:capture_screenshot` / `browser:capture_region` / `browser:screencast` / `browser:export_page`                                  |
| 上传与取资源       | `browser:upload_file` / `browser:fetch_resource`                                                                                        |
| 性能               | `browser:performance`                                                                                                                   |
| recipe 与用户脚本  | `browser:recipe` / `browser:generate_recipe_skeleton` / `browser:rerun_recipe_from_run` / `browser:user_scripts`                        |

## 主要导出

- `browserTools` —— 按工具名索引的不可变工具定义集合。
- `ToolBrowserApi` —— **已绑定到当前 session** 的浏览器能力端口(全仓唯一权威契约)。
- `BrowserToolContext` —— 单次执行的 browser、`abortSignal` 与宿主附加上下文。
- `VelaTool` —— 名称 / schema / 权限 / 能力元数据 / `execute()` 的结构契约。

## 依赖注入

第三方宿主**只需实现 `ToolBrowserApi`**。可以用 `CdpBrowserRuntime.bindBrowserApi()`
(其返回面由 `src/tools/CdpBrowserRuntimeContract.ts` 在**编译期**保证满足本契约),
也可以把 Playwright、远程浏览器服务或自研 runtime 适配成同一接口。

```ts
import {
  browserTools,
  type BrowserToolContext,
  type ToolBrowserApi,
} from "@velaros-ai/browser/tools";

const browser: ToolBrowserApi = createPlaywrightBrowserAdapter(page);

for (const tool of Object.values(browserTools)) {
  thirdPartyAgent.registerTool({
    name: tool.name,
    schema: tool.schema,
    execute: (input, signal) => {
      const context: BrowserToolContext = {
        browser,
        abortSignal: signal,
        execution: null,
      };
      return tool.execute(input, context);
    },
  });
}
```

## 生命周期与并发

工具定义**无状态**,进程内可复用。宿主为每次调用创建或解析一个绑定当前 session 的
`BrowserToolContext`。取消经 `AbortSignal` 传递;真正的动作串行化由注入的 browser runtime 负责,
不在工具层做。

## 错误模型

Zod 在**最外层**校验输入,工具内部**不重复归一化同一输入**。
无活动会话、权限不足、执行失败由宿主 API 抛 `AppError` 或等价结构化错误;
agent 运行时应保留错误码与 cause。

## 边界

不依赖 `@velaros-ai/agent`、不碰产品 IPC、不创建浏览器、不保存会话、不管 UI。
本切片只定义工具与其 context 契约;运行时执行、会话所有权与界面都由宿主组合。

## 扩展点

新增浏览器工具要沿用现有工具 contract:声明权限、effect、并发语义与 zod schema。
**宿主专属操作不进默认 `browserTools`**——在应用侧组合自己的额外集合。
