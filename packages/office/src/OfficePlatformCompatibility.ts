/**
 * 路径包含判断不在这里：它按真实路径算（见 `officeShared` 的 `assertOfficePathInsideProject`），
 * 用 `@velaros-ai/core` 的 `resolveRealPath` 与 `@velaros-ai/platform` 的 `isPathTextInside`。
 * 本文件原先那份按字面路径算的 `getRelativePathInsideOfficeRoot` 放行了符号链接逃逸，已删。
 */
export class OfficePlatformCompatibility {
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  public quoteShellArg(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`
  }

  public quoteShellPath(value: string): string {
    return this.quoteShellArg(this.platform === 'win32' ? value.replace(/\\/g, '/') : value)
  }
}

/** 当前进程使用的 Office 平台原语。 */
export const officePlatformCompatibility = new OfficePlatformCompatibility()
