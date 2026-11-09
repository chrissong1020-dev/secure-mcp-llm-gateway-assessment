import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCustomerMcpServer } from "../src/task1-mcp-server.js";

describe("customer MCP server", () => {
  const closeables: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((item) => item.close()));
  });

  async function connectedClient() {
    const server = createCustomerMcpServer();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);
    return client;
  }

  it("lists both tools and accepts a valid lookup", async () => {
    const client = await connectedClient();
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "get_customer_record",
      "trigger_refund",
    ]);

    const result = await client.callTool({
      name: "get_customer_record",
      arguments: { customer_id: "CUST-A12B3" },
    });
    expect(result.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("CUST-A12B3") }),
    ]);
  });

  it("maps invalid arguments to JSON-RPC Invalid Params", async () => {
    const client = await connectedClient();
    await expect(
      client.callTool({
        name: "trigger_refund",
        arguments: { customer_id: "123", amount: -1, reason: "short" },
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("runs over stdio without corrupting the JSON-RPC channel", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", resolve("src/task1-mcp-server.ts")],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "1.0.0" });
    await client.connect(transport);
    closeables.push(client);

    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(2);
  });
});
