import type {
  BrowserCaptureScreenshotOptions,
  BrowserScreenshotPolicyDefaults,
  BrowserScreenshotPolicyOptions,
} from '../../types/browser.js'
import { buildBrowserScreenshotOptions } from '../../utils/screenshot-options.js'

/**
 * 截图选项的纯策略门面：把宿主缺省与调用方给的选项合成一份完整选项。
 *
 * 渲染进程的预览窗口与主进程的工具调用共用这一份合成规则，免得「模型看到的图」与
 * 「用户看到的图」按两套缺省走。
 */
export interface BrowserScreenshotPolicyApi {
  /** 合成一份完整的截图选项；两侧都不给时按包内缺省。 */
  buildOptions(
    input?: BrowserScreenshotPolicyOptions,
    defaults?: BrowserScreenshotPolicyDefaults
  ): BrowserCaptureScreenshotOptions
}

/** 见 {@link BrowserScreenshotPolicyApi}。 */
class BrowserScreenshotPolicy implements BrowserScreenshotPolicyApi {
  public buildOptions(
    input: BrowserScreenshotPolicyOptions = {},
    defaults: BrowserScreenshotPolicyDefaults = {}
  ): BrowserCaptureScreenshotOptions {
    return buildBrowserScreenshotOptions(input, defaults)
  }
}

/** 整个进程共用的截图策略实例。 */
export const browserScreenshotPolicy: BrowserScreenshotPolicyApi = new BrowserScreenshotPolicy()
