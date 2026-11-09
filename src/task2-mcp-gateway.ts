import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { roleFromAuthorization } from "./shared/auth.js";
import { HttpInputError, listen, readJsonBody, sendJson } from "./shared/http.js";

const jsonRpcRequestSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    method: z.string().min(1),
    params: z.unknown().optional(),
  })
  .passthrough();

interface McpGatewayOptions {
  downstreamUrl: string;
  authSecret: string;
  fetchImpl?: typeof fetch;
}

function rpcError(id: unknown, code: number, message: string) {
  return {
    jsonrpc: "2.0",
    id: typeof id === "string" || typeof id === "number" || id === null ? id : null,
    error: { code, message },
  };
}

export function createMcpGateway(options: McpGatewayOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;

  return createServer(async (request, response) => {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Only POST is supported." });
      return;
    }

    let rawPayload: unknown;
    try {
      rawPayload = await readJsonBody(request);
    } catch (error) {
      const status = error instanceof HttpInputError ? error.status : 400;
      sendJson(response, status, rpcError(null, -32700, "Parse error"));
      return;
    }

    const parsed = jsonRpcRequestSchema.safeParse(rawPayload);
    if (!parsed.success) {
      sendJson(response, 400, rpcError(null, -32600, "Invalid Request"));
      return;
    }

    const payload = parsed.data;
    const toolName = getCalledToolName(payload.method, payload.params);
    if (toolName?.startsWith("admin_")) {
      const role = await roleFromAuthorization(
        request.headers.authorization,
        options.authSecret,
      );
      if (role !== "admin") {
        sendJson(
          response,
          403,
          rpcError(payload.id, -32001, "Unauthorized Tool Call"),
        );
        return;
      }
    }

    await forwardRequest(request, response, payload, options.downstreamUrl, fetchImpl);
  });
}

function getCalledToolName(method: string, params: unknown): string | null {
  if (method !== "tools/call") return null;
  if (!params || typeof params !== "object" || !("name" in params)) return null;
  return typeof params.name === "string" ? params.name : null;
}

async function forwardRequest(
  original: IncomingMessage,
  response: ServerResponse,
  payload: unknown,
  downstreamUrl: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  try {
    const headers = new Headers({ "content-type": "application/json" });
    // The downstream service may have its own auth policy, so preserve the credential.
    if (original.headers.authorization) {
      headers.set("authorization", original.headers.authorization);
    }

    const downstream = await fetchImpl(downstreamUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await downstream.text();
    response.writeHead(downstream.status, {
      "content-type": downstream.headers.get("content-type") ?? "application/json",
    });
    response.end(body);
  } catch {
    sendJson(response, 502, rpcError(null, -32000, "Downstream MCP server unavailable"));
  }
}

export async function main(): Promise<void> {
  const downstreamUrl = process.env.MCP_DOWNSTREAM_URL;
  const authSecret = process.env.AUTH_SECRET;
  if (!downstreamUrl || !authSecret || authSecret.length < 32) {
    throw new Error("MCP_DOWNSTREAM_URL and AUTH_SECRET are required");
  }

  const port = Number(process.env.MCP_GATEWAY_PORT ?? 8080);
  const server = createMcpGateway({ downstreamUrl, authSecret });
  await listen(server, port);
  console.error(`MCP security gateway listening on http://127.0.0.1:${port}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error("MCP gateway failed to start:", error);
    process.exitCode = 1;
  });
}
