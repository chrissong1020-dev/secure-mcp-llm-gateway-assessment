import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRouter, type ModelProvider } from "./model-router.js";
import { HttpInputError, listen, readJsonBody, sendJson } from "./shared/http.js";
import { SlidingWindowRateLimiter } from "./sliding-window-rate-limiter.js";

interface RouterGatewayOptions {
  router: ModelRouter;
}

export function createRouterGateway({ router }: RouterGatewayOptions) {
  return createServer(async (request, response) => {
    const requestId = randomUUID();
    if (request.method !== "POST" || request.url !== "/v1/completions") {
      sendJson(response, 404, {
        error: { code: "NOT_FOUND", message: "Route not found.", request_id: requestId },
      });
      return;
    }

    const tenantKey = request.headers["x-tenant-api-key"];
    if (typeof tenantKey !== "string" || tenantKey.length < 8) {
      sendJson(response, 401, {
        error: {
          code: "UNAUTHENTICATED",
          message: "A tenant API key is required.",
          request_id: requestId,
        },
      });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      const status = error instanceof HttpInputError ? error.status : 400;
      sendJson(response, status, {
        error: {
          code: "INVALID_REQUEST",
          message: "A valid JSON body is required.",
          request_id: requestId,
        },
      });
      return;
    }

    const result = await router.route(tenantKey, body);
    for (const [name, value] of Object.entries(result.headers ?? {})) {
      response.setHeader(name, value);
    }
    sendJson(response, result.status, result.body);
  });
}

function providerFromEnvironment(prefix: "PRIMARY" | "SECONDARY"): ModelProvider {
  const url = process.env[`${prefix}_MODEL_URL`];
  const apiKey = process.env[`${prefix}_MODEL_API_KEY`];
  if (!url || !apiKey) throw new Error(`${prefix}_MODEL_URL and ${prefix}_MODEL_API_KEY are required`);
  return { name: prefix.toLowerCase(), url, apiKey };
}

export async function main(): Promise<void> {
  const limiter = await SlidingWindowRateLimiter.open(
    resolve(process.env.RATE_LIMIT_DB ?? "./data/rate-limits.sqlite"),
    Number(process.env.TOKEN_LIMIT_PER_MINUTE ?? 50_000),
  );
  const router = new ModelRouter({
    primary: providerFromEnvironment("PRIMARY"),
    secondary: providerFromEnvironment("SECONDARY"),
    limiter,
    timeoutMs: 3_000,
  });
  const port = Number(process.env.ROUTER_GATEWAY_PORT ?? 8082);
  const server = createRouterGateway({ router });
  await listen(server, port);
  console.error(`model router listening on http://127.0.0.1:${port}`);

  const shutdown = () => server.close(() => limiter.close());
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error("model router failed to start:", error);
    process.exitCode = 1;
  });
}
