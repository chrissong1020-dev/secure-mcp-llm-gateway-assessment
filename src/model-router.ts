import { createHash, randomUUID } from "node:crypto";
import { encode } from "gpt-tokenizer";
import type { SlidingWindowRateLimiter } from "./sliding-window-rate-limiter.js";

export interface ModelProvider {
  name: string;
  url: string;
  apiKey: string;
}

export interface ModelRouterOptions {
  primary: ModelProvider;
  secondary: ModelProvider;
  limiter: SlidingWindowRateLimiter;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface GatewayResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export class ModelRouter {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ModelRouterOptions) {
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async route(tenantKey: string, requestBody: unknown): Promise<GatewayResult> {
    const requestId = randomUUID();
    const estimatedTokens = estimateRequestTokens(requestBody);
    let reservation;
    try {
      // Store a stable tenant identity in SQLite, never the API key itself.
      const tenantId = createHash("sha256").update(tenantKey).digest("hex");
      reservation = await this.options.limiter.reserve(tenantId, estimatedTokens);
    } catch {
      return gatewayError(503, "GATEWAY_UNAVAILABLE", "The gateway is temporarily unavailable.", requestId);
    }

    if (!reservation.allowed) {
      return {
        status: 429,
        headers: { "retry-after": String(Math.ceil(reservation.retryAfterMs / 1_000)) },
        body: {
          error: {
            code: "TOKEN_RATE_LIMITED",
            message: "Tenant token budget exceeded.",
            request_id: requestId,
            retry_after_ms: reservation.retryAfterMs,
          },
        },
      };
    }

    const primary = await this.callProvider(this.options.primary, requestBody);
    let result = primary;
    if (primary.kind === "timeout" || primary.status === 429) {
      result = await this.callProvider(this.options.secondary, requestBody);
    }

    if (result.kind === "success") {
      const actualTokens = readActualTokenUsage(result.body);
      if (actualTokens !== null) {
        await this.options.limiter.reconcile(reservation.reservationId, actualTokens);
      }
      return {
        status: 200,
        body: result.body,
        headers: { "x-model-provider": result.provider },
      };
    }

    // A network failure is not billable. A timeout is deliberately retained as
    // a reservation because the provider may have completed the work after the
    // gateway stopped waiting.
    if (result.kind === "network-error") {
      await this.options.limiter.release(reservation.reservationId);
    }

    if (result.status === 429) {
      return gatewayError(503, "ALL_MODELS_THROTTLED", "No model capacity is currently available.", requestId);
    }
    if (result.kind === "timeout") {
      return gatewayError(504, "MODEL_TIMEOUT", "The model request timed out.", requestId);
    }
    return gatewayError(502, "MODEL_PROVIDER_ERROR", "The model provider could not complete the request.", requestId);
  }

  private async callProvider(
    provider: ModelProvider,
    body: unknown,
  ): Promise<ProviderResult> {
    const controller = new AbortController();
    let didTimeOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        didTimeOut = true;
        controller.abort();
        reject(new GatewayTimeoutError());
      }, this.timeoutMs);
    });
    try {
      const response = await Promise.race([
        this.fetchImpl(provider.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${provider.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        deadline,
      ]);
      if (!response.ok) return { kind: "provider-error", status: response.status };

      try {
        return {
          kind: "success",
          status: response.status,
          body: await response.json(),
          provider: provider.name,
        };
      } catch {
        return { kind: "provider-error", status: 502 };
      }
    } catch (error) {
      if (didTimeOut || controller.signal.aborted || isTimeoutError(error)) {
        return { kind: "timeout" };
      }
      return { kind: "network-error" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

class GatewayTimeoutError extends Error {
  override name = "TimeoutError";
}

type ProviderResult =
  | { kind: "success"; status: number; body: unknown; provider: string }
  | { kind: "provider-error"; status: number }
  | { kind: "timeout"; status?: never }
  | { kind: "network-error"; status?: never };

export function estimateRequestTokens(body: unknown): number {
  if (!body || typeof body !== "object") return 1;
  const request = body as Record<string, unknown>;
  let prompt = "";
  if (typeof request.prompt === "string") prompt += request.prompt;
  if (Array.isArray(request.messages)) {
    for (const message of request.messages) {
      if (message && typeof message === "object") {
        const content = (message as Record<string, unknown>).content;
        if (typeof content === "string") prompt += `\n${content}`;
        else if (content !== undefined) prompt += `\n${JSON.stringify(content)}`;
      }
    }
  }
  if (request.tools !== undefined) prompt += `\n${JSON.stringify(request.tools)}`;

  const outputBudget =
    typeof request.max_tokens === "number" && Number.isFinite(request.max_tokens)
      ? Math.max(0, Math.ceil(request.max_tokens))
      : 256;
  return Math.max(1, encode(prompt).length + outputBudget);
}

function readActualTokenUsage(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const usage = (body as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return null;
  const total = (usage as Record<string, unknown>).total_tokens;
  return typeof total === "number" && Number.isFinite(total) && total > 0
    ? Math.ceil(total)
    : null;
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function gatewayError(
  status: number,
  code: string,
  message: string,
  requestId: string,
): GatewayResult {
  return {
    status,
    body: { error: { code, message, request_id: requestId } },
  };
}
