export interface BrowserCommandSpec {
  file: string
  args: string[]
}

export class BrowserPlatformCompatibility {
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  public getProcessTreeKillCommandSpec(pid: number, signal: NodeJS.Signals): BrowserCommandSpec | null {
    if (this.platform !== 'win32') return null
    return {
      file: 'taskkill.exe',
      args: ['/pid', String(pid), '/t', ...(signal === 'SIGKILL' ? ['/f'] : [])],
    }
  }
}
