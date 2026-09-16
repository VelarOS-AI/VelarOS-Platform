import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import type { JsonObject, JsonValue } from "../protocol/index.js";

/**
 * 只有「请求肯定没到服务端」时才重试的 errno：服务还没起来、地址解析不出来。
 *
 * 发命令（POST）是**非幂等**的：一条「发送这段提示词」重发两次就是发了两遍。
 * 连接被拒/域名解析失败说明这次请求根本没出去，重试安全；一旦服务端有了响应
 * （4xx / 5xx），就不能再发第二遍。
 */
const RetryableConnectErrnoCodes = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

/** 读出错误（或它的 cause，fetch 把系统错误包在 cause 里）上的 errno 码。 */
function errnoCode(error: unknown): string | null {
  for (const candidate of [error, (error as { cause?: unknown })?.cause]) {
    const code = (candidate as { code?: unknown })?.code;
    if (typeof code === "string") return code;
  }
  return null;
}

export interface HooksEndpoint {
  readonly url: string;
  readonly token: string;
}

export interface VelarHooksClientOptions {
  readonly endpointFile?: string;
  readonly endpoint?: HooksEndpoint;
  readonly retries?: number;
  readonly retryMs?: number;
  readonly source?: string;
}

export interface HookResponse {
  readonly ok: boolean;
  readonly status?: string;
  readonly data?: JsonValue;
  readonly error?: JsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asEndpoint(value: unknown, source: string): HooksEndpoint {
  if (
    !isRecord(value) ||
    typeof value.url !== "string" ||
    typeof value.token !== "string"
  ) {
    throw new Error(`Velar hooks 凭据文件的内容不合法：${source}`);
  }
  return { url: value.url, token: value.token };
}

function asJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(asJsonValue);
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, asJsonValue(item)]),
    );
  return String(value);
}

export class VelarHooksClient {
  private readonly options: Required<
    Pick<VelarHooksClientOptions, "retries" | "retryMs" | "source">
  > &
    Pick<VelarHooksClientOptions, "endpoint" | "endpointFile">;

  constructor(options: VelarHooksClientOptions = {}) {
    this.options = {
      endpointFile: options.endpointFile,
      endpoint: options.endpoint,
      retries: options.retries ?? 12,
      retryMs: options.retryMs ?? 2_500,
      source: options.source ?? "agent-lab",
    };
  }

  /**
   * 解析 hooks 地址与 token：显式 endpoint → 环境变量 → 凭据文件（显式给的，或
   * `VELAR_HOOKS_ENDPOINT_FILE` 指的那个）。
   *
   * **没有缺省文件路径**。这个文件里带 token，是凭据文件而不是发现文件：原先缺省读
   * `os.tmpdir()/velaros-hooks-endpoint.json`，多用户 Linux 上 `/tmp` 是共享粘滞位目录，
   * 固定文件名是符号链接攻击的经典靶子——别人放一份同名文件就能把命令（含提示词）导到
   * 他的地址上；而宿主早已把这份文件挪进了自己的用户私有目录，那个缺省路径也从来读不到。
   * 本包是 host 无关的，不去猜宿主的数据目录在哪，由调用方给路径（宿主与本包认同一个
   * 环境变量 `VELAR_HOOKS_ENDPOINT_FILE`）。
   */
  private async endpoint(): Promise<HooksEndpoint> {
    if (this.options.endpoint) return this.options.endpoint;
    const fromEnvironment =
      process.env.VELAR_HOOKS_URL && process.env.VELAR_HOOKS_TOKEN
        ? {
            url: process.env.VELAR_HOOKS_URL,
            token: process.env.VELAR_HOOKS_TOKEN,
          }
        : null;
    if (fromEnvironment) return fromEnvironment;
    const endpointFile =
      this.options.endpointFile?.trim() ||
      process.env.VELAR_HOOKS_ENDPOINT_FILE?.trim();
    if (!endpointFile) {
      throw new Error(
        "找不到 Velar hooks 的地址：请传 endpoint / endpointFile，或设置 VELAR_HOOKS_URL 与 VELAR_HOOKS_TOKEN，" +
          "或用 VELAR_HOOKS_ENDPOINT_FILE 指向宿主写的凭据文件。",
      );
    }
    const text = await readFile(endpointFile, "utf8");
    return asEndpoint(JSON.parse(text), endpointFile);
  }

  /**
   * 发一条命令。
   *
   * **重试只在「请求肯定没到服务端」时发生**：连不上（宿主还没起来）或凭据文件还没写出来。
   * 服务端一旦答了话就不再重试——4xx 是请求本身的问题，重试只是把同一个错误再发十几遍
   * （401 要等约 30 秒才失败）；5xx 说明请求已经到了，而发命令是非幂等的，重发等于把同一段
   * 提示词发两遍。
   */
  public async command(payload: JsonObject): Promise<HookResponse> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.options.retries; attempt += 1) {
      let endpoint: HooksEndpoint;
      try {
        endpoint = await this.endpoint();
      } catch (error) {
        // 地址还没拿到，命令根本没发出去：可以等宿主把凭据文件写出来再试。
        lastError = error;
        if (attempt === this.options.retries) break;
        await delay(this.options.retryMs);
        continue;
      }

      let response: Response;
      try {
        response = await fetch(`${endpoint.url}/v1/hooks/commands`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${endpoint.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ source: this.options.source, ...payload }),
        });
      } catch (error) {
        lastError = error;
        const code = errnoCode(error);
        if (
          code === null ||
          !RetryableConnectErrnoCodes.has(code) ||
          attempt === this.options.retries
        ) {
          break;
        }
        await delay(this.options.retryMs);
        continue;
      }

      const raw: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          `Velar hooks 请求失败（${response.status}）：${JSON.stringify(raw)}`,
        );
      }
      if (!isRecord(raw) || typeof raw.ok !== "boolean") {
        throw new Error("Velar hooks 的回执信封不合法");
      }
      return {
        ok: raw.ok,
        ...(typeof raw.status === "string" ? { status: raw.status } : {}),
        ...("data" in raw ? { data: asJsonValue(raw.data) } : {}),
        ...("error" in raw ? { error: asJsonValue(raw.error) } : {}),
      };
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Velar hooks 请求失败");
  }
}
