import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { listen, readJsonBody, sendJson } from "./shared/http.js";

function idFrom(payload: unknown): unknown {
  return payload && typeof payload === "object" && "id" in payload
    ? payload.id
    : null;
}

export async function main(): Promise<void> {
  const port = Number(process.env.MOCK_MCP_PORT ?? 9090);
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/mcp") {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    const payload = await readJsonBody(request);
    const method =
      payload && typeof payload === "object" && "method" in payload
        ? payload.method
        : null;
    if (method === "tools/list") {
      sendJson(response, 200, {
        jsonrpc: "2.0",
        id: idFrom(payload),
        result: {
          tools: [
            { name: "get_status", inputSchema: { type: "object" } },
            { name: "admin_reset_key", inputSchema: { type: "object" } },
          ],
        },
      });
      return;
    }
    if (method === "tools/call") {
      sendJson(response, 200, {
        jsonrpc: "2.0",
        id: idFrom(payload),
        result: { content: [{ type: "text", text: "mock tool completed" }] },
      });
      return;
    }
    sendJson(response, 200, {
      jsonrpc: "2.0",
      id: idFrom(payload),
      error: { code: -32601, message: "Method not found" },
    });
  });

  await listen(server, port);
  console.error(`mock MCP HTTP server listening on http://127.0.0.1:${port}/mcp`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error("mock MCP server failed:", error);
    process.exitCode = 1;
  });
}
