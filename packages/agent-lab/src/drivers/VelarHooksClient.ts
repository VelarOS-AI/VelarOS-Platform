import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { JsonObject, JsonValue } from "../protocol/index.js";

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
    throw new Error(`Invalid Velar hooks endpoint: ${source}`);
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
    Pick<
      VelarHooksClientOptions,
      "endpointFile" | "retries" | "retryMs" | "source"
    >
  > &
    Pick<VelarHooksClientOptions, "endpoint">;

  constructor(options: VelarHooksClientOptions = {}) {
    this.options = {
      endpointFile:
        options.endpointFile ?? join(tmpdir(), "velaros-hooks-endpoint.json"),
      endpoint: options.endpoint,
      retries: options.retries ?? 12,
      retryMs: options.retryMs ?? 2_500,
      source: options.source ?? "agent-lab",
    };
  }

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
    const text = await readFile(this.options.endpointFile, "utf8");
    return asEndpoint(JSON.parse(text), this.options.endpointFile);
  }

  public async command(payload: JsonObject): Promise<HookResponse> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.options.retries; attempt += 1) {
      try {
        const endpoint = await this.endpoint();
        const response = await fetch(`${endpoint.url}/v1/hooks/commands`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${endpoint.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ source: this.options.source, ...payload }),
        });
        const raw: unknown = await response.json().catch(() => null);
        if (response.ok) {
          if (!isRecord(raw) || typeof raw.ok !== "boolean") {
            throw new Error(
              "Velar hooks returned an invalid response envelope",
            );
          }
          return {
            ok: raw.ok,
            ...(typeof raw.status === "string" ? { status: raw.status } : {}),
            ...("data" in raw ? { data: asJsonValue(raw.data) } : {}),
            ...("error" in raw ? { error: asJsonValue(raw.error) } : {}),
          };
        }
        if (response.status < 500 || attempt === this.options.retries) {
          throw new Error(
            `Velar hooks request failed (${response.status}): ${JSON.stringify(raw)}`,
          );
        }
        lastError = new Error(
          `Velar hooks request failed (${response.status})`,
        );
      } catch (error) {
        lastError = error;
        if (attempt === this.options.retries) break;
      }
      await delay(this.options.retryMs);
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Velar hooks request failed");
  }
}
