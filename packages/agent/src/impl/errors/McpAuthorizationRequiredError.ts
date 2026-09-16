/** 远程 MCP 明确要求 OAuth 时抛出；登录流程仍由产品宿主拥有。 */
export class McpAuthorizationRequiredError extends Error {
  public constructor(readonly authorizationUrl: Nullable<string>) {
    super('MCP OAuth authorization is required.')
    this.name = 'McpAuthorizationRequiredError'
  }
}
