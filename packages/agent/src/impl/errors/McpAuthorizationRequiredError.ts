/** 远程 MCP 明确要求 OAuth 时抛出；登录流程仍由产品宿主拥有。 */
export class McpAuthorizationRequiredError extends Error {
  public constructor(readonly authorizationUrl: Nullable<string>) {
    super('这个 MCP 服务器要求先完成 OAuth 授权才能调用，本次请求已被拒绝。请在宿主产品里走完授权流程后重试。')
    this.name = 'McpAuthorizationRequiredError'
  }
}
