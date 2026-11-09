import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createTestToken } from "../src/shared/auth.js";
import { createMcpGateway } from "../src/task2-mcp-gateway.js";

const SECRET = "this-is-a-long-test-only-secret-value";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

async function start(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  return `http://127.0.0.1:${address.port}`;
}

describe("MCP security gateway", () => {
  it("blocks an admin tool before the downstream is called", async () => {
    let downstreamCalls = 0;
    const downstreamUrl = await start(
      createServer((_request, response) => {
        downstreamCalls += 1;
        response.end("{}");
      }),
    );
    const gatewayUrl = await start(createMcpGateway({ downstreamUrl, authSecret: SECRET }));
    const viewerToken = await createTestToken("viewer", SECRET);

    const response = await fetch(gatewayUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${viewerToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "admin_reset_key", arguments: {} },
      }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32001, message: "Unauthorized Tool Call" },
    });
    expect(downstreamCalls).toBe(0);
  });

  it("forwards tools/list and permits an authenticated admin", async () => {
    const seenMethods: string[] = [];
    const downstreamUrl = await start(
      createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        seenMethods.push((JSON.parse(body) as { method: string }).method);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
      }),
    );
    const gatewayUrl = await start(createMcpGateway({ downstreamUrl, authSecret: SECRET }));
    const adminToken = await createTestToken("admin", SECRET);

    await fetch(gatewayUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    await fetch(gatewayUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "admin_reset_key", arguments: {} },
      }),
    });

    expect(seenMethods).toEqual(["tools/list", "tools/call"]);
  });
});
