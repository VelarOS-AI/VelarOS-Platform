/**
 * 按模式遮盖密钥：`PatternSecretRedactionProvider` 与根入口导出的工厂 `createSecretRedactionProvider`。
 * 实现的接口 `SecretRedactionProvider` 在注入面（contract/requires.ts）；宿主把工厂造出的实例放进 providers.secretRedaction。
 */
import { ProjectRedactionMarker } from '../../contract/constants.js'
import type { SecretRedactionProvider } from '../../contract/requires.js'
import type { RedactionInput, RedactionResult } from '../../types/provider.js'

/** 把正文里像密钥的片段换成占位符（`ProjectRedactionMarker`）：sk- 开头的长串整段遮住；api_key、token、secret 这类赋值只遮值、保留键名。 */
export class PatternSecretRedactionProvider implements SecretRedactionProvider {
  private static readonly Patterns = [
    /(sk-[a-zA-Z0-9_-]{12,})/g,
    /((?:api|secret|access|refresh|private)[_ -]?(?:key|token|secret)\s*[:=]\s*)([^\s"']+)/gi,
  ];

  public redact({ content }: RedactionInput): RedactionResult {
    let redacted = false;
    let next = content;
    for (const pattern of PatternSecretRedactionProvider.Patterns) {
      next = next.replace(pattern, (...args: any[]) => {
        redacted = true;
        if (args.length > 3 && String(args[1]).match(/key|token|secret/i)) return `${args[1]}${ProjectRedactionMarker}`;
        return ProjectRedactionMarker;
      });
    }
    return { content: next, redacted };
  }
}

/** 造一个按模式遮盖密钥的提供者，宿主放进 providers.secretRedaction；读取、搜索结果和证据包离开项目前都经它遮一遍。 */
export function createSecretRedactionProvider(): SecretRedactionProvider {
  return new PatternSecretRedactionProvider()
}
