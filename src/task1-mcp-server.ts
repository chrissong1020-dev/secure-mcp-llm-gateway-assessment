import { fileURLToPath } from "node:url";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export const customerIdSchema = z
  .string()
  .regex(/^CUST-[A-Z0-9]{5}$/, "Expected CUST- followed by five letters or digits");

export const getCustomerRecordSchema = z
  .object({ customer_id: customerIdSchema })
  .strict();

export const triggerRefundSchema = z
  .object({
    customer_id: customerIdSchema,
    amount: z.number().finite().positive(),
    reason: z.string().trim().min(10),
  })
  .strict();

const tools = [
  {
    name: "get_customer_record",
    description: "Look up a customer record by its public customer ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        customer_id: {
          type: "string",
          pattern: "^CUST-[A-Z0-9]{5}$",
          description: "A customer ID such as CUST-A12B3",
        },
      },
      required: ["customer_id"],
      additionalProperties: false,
    },
  },
  {
    name: "trigger_refund",
    description: "Create a refund request for a customer.",
    inputSchema: {
      type: "object" as const,
      properties: {
        customer_id: { type: "string", pattern: "^CUST-[A-Z0-9]{5}$" },
        amount: { type: "number", exclusiveMinimum: 0 },
        reason: { type: "string", minLength: 10 },
      },
      required: ["customer_id", "amount", "reason"],
      additionalProperties: false,
    },
  },
];

function parseArguments<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input ?? {});
  if (result.success) return result.data;

  throw new McpError(ErrorCode.InvalidParams, "Invalid tool arguments", {
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
      code: issue.code,
    })),
  });
}

export function createCustomerMcpServer(): Server {
  const server = new Server(
    { name: "customer-operations", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    switch (request.params.name) {
      case "get_customer_record": {
        const { customer_id } = parseArguments(
          getCustomerRecordSchema,
          request.params.arguments,
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                customer_id,
                name: "Sample Customer",
                status: "active",
              }),
            },
          ],
        };
      }

      case "trigger_refund": {
        const refund = parseArguments(triggerRefundSchema, request.params.arguments);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                refund_id: `RFND-${crypto.randomUUID()}`,
                status: "accepted",
                ...refund,
              }),
            },
          ],
        };
      }

      default:
        throw new McpError(
          ErrorCode.InvalidParams,
          `Unknown tool: ${request.params.name}`,
        );
    }
  });

  return server;
}

export async function main(): Promise<void> {
  const server = createCustomerMcpServer();
  const transport = new StdioServerTransport();

  // stdout belongs to the stdio transport. Operational messages always use stderr.
  console.error("customer MCP server ready on stdio");
  await server.connect(transport);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error("customer MCP server stopped:", error);
    process.exitCode = 1;
  });
}
