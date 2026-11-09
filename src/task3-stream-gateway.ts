import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { HttpInputError, listen, readJsonBody, sendJson, writeWithBackpressure } from "./shared/http.js";
import { redactOpenAiSse } from "./openai-sse-redactor.js";

interface StreamGatewayOptions {
  upstreamUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export function createStreamGateway(options: StreamGatewayOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;

  return createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Route not found." } });
      return;
    }

    let payload: unknown;
    try {
      payload = await readJsonBody(request);
    } catch (error) {
      const status = error instanceof HttpInputError ? error.status : 400;
      sendJson(response, status, {
        error: { code: "INVALID_REQUEST", message: "A valid JSON body is required." },
      });
      return;
    }

    let upstream: Response;
    try {
      upstream = await fetchImpl(options.upstreamUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({ ...(payload as object), stream: true }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      sendJson(response, 502, {
        error: { code: "PROVIDER_UNAVAILABLE", message: "The model provider is unavailable." },
      });
      return;
    }

    if (!upstream.ok || !upstream.body) {
      // Do not echo the provider response: it can contain credentials or internals.
      sendJson(response, 502, {
        error: { code: "PROVIDER_ERROR", message: "The model provider rejected the request." },
      });
      return;
    }

    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.flushHeaders();

    try {
      for await (const event of redactOpenAiSse(upstream.body)) {
        await writeWithBackpressure(response, event);
      }
      response.end();
    } catch {
      // Headers have already been sent. End cleanly without leaking the exception.
      response.end();
    }
  });
}

export async function main(): Promise<void> {
  const upstreamUrl = process.env.LLM_STREAM_URL;
  const apiKey = process.env.LLM_STREAM_API_KEY;
  if (!upstreamUrl || !apiKey) {
    throw new Error("LLM_STREAM_URL and LLM_STREAM_API_KEY are required");
  }

  const port = Number(process.env.STREAM_GATEWAY_PORT ?? 8081);
  const server = createStreamGateway({ upstreamUrl, apiKey });
  await listen(server, port);
  console.error(`stream guardrail listening on http://127.0.0.1:${port}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error("stream gateway failed to start:", error);
    process.exitCode = 1;
  });
}
