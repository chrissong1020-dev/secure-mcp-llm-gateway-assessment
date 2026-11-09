# MCP and LLM Gateway Assessment

This repository contains four deliberately small TypeScript services. Each task can be read and run on its own; shared code is limited to HTTP and authentication helpers.

## Quick start

Requirements: Node.js 20.18 or newer.

```powershell
npm install
npm run check
Copy-Item .env.example .env
```

The code reads environment variables from the process. It does not load `.env` automatically, which avoids surprising configuration behavior in production. Export the values in your shell or use your normal process manager.

| Task | Entry point | Run command | Default port |
| --- | --- | --- | --- |
| 1. MCP server | `src/task1-mcp-server.ts` | `npm run task1` | stdio |
| 2. MCP security gateway | `src/task2-mcp-gateway.ts` | `npm run task2` | 8080 |
| 3. Streaming PII guardrail | `src/task3-stream-gateway.ts` | `npm run task3` | 8081 |
| 4. Rate limit/fallback router | `src/task4-router-gateway.ts` | `npm run task4` | 8082 |

## Task 1: strict stdio MCP server

The server uses the official `@modelcontextprotocol/sdk` low-level `Server` API. Zod performs strict runtime validation, including rejecting unknown properties. Validation failures throw `McpError(ErrorCode.InvalidParams)`, which the SDK serializes as JSON-RPC error `-32602`.

`stdout` is owned by `StdioServerTransport`; startup and failure logs use `console.error` only. The test suite starts a real child process through the SDK's `StdioClientTransport`, so an accidental stdout log would break the test.

Example MCP client configuration:

```json
{
  "mcpServers": {
    "customer-operations": {
      "command": "npm",
      "args": ["run", "task1"],
      "cwd": "D:/projects/quilr"
    }
  }
}
```

The customer store and refund operation are intentionally mocked. The assessment's boundary is protocol handling and validation, not a payment integration.

## Task 2: MCP authorization proxy

Start the included downstream mock and the gateway in separate terminals:

```powershell
$env:AUTH_SECRET = "replace-with-at-least-32-random-characters"
$env:MCP_DOWNSTREAM_URL = "http://127.0.0.1:9090/mcp"
npm run mock:mcp
```

```powershell
$env:AUTH_SECRET = "replace-with-at-least-32-random-characters"
$env:MCP_DOWNSTREAM_URL = "http://127.0.0.1:9090/mcp"
npm run task2
```

Create a short-lived, signed test token:

```powershell
$env:AUTH_SECRET = "replace-with-at-least-32-random-characters"
npm run token -- admin
```

The proxy verifies an HS256 JWT's signature, issuer, audience, expiry, and `role` claim. `tools/list` and ordinary calls pass through. A `tools/call` whose name begins with `admin_` is stopped locally unless the verified role is `admin`; the downstream is never contacted. Malformed JSON-RPC requests receive standard `-32700` or `-32600` errors.

For production, replace the local signer with the organization's OIDC/JWKS verifier and decide explicitly whether client credentials should be exchanged rather than forwarded.

## Task 3: streaming PII guardrail

Configure `LLM_STREAM_URL` and `LLM_STREAM_API_KEY`, then run `npm run task3`. Clients use the OpenAI-compatible endpoint:

```text
POST http://127.0.0.1:8081/v1/chat/completions
```

The gateway parses SSE frames incrementally and maintains one small redaction state per choice index. It holds only the unfinished token at a chunk boundary, so values such as `alice@exa` + `mple.com` cannot evade the filter. Email addresses, SSNs, and Luhn-valid 13–19 digit card numbers are replaced with `[REDACTED]`. Response writes honor backpressure, and the full completion is never accumulated.

Regex guardrails are a useful last-mile control, not a complete DLP program. A production design should add policy-specific detectors, structured audit metrics, and provider-side safety controls.

## Task 4: SQLite sliding window and fallback

Configure both model providers and run `npm run task4`. Send requests to:

```text
POST http://127.0.0.1:8082/v1/completions
X-Tenant-Api-Key: tenant-secret-key
```

The router tokenizes the prompt, messages, and tools with `gpt-tokenizer`, then reserves the requested output budget (`max_tokens`, default 256). Reservations are serialized through an async lock and persisted atomically to a real SQLite file. Successful responses reconcile the reservation with `usage.total_tokens`. Raw tenant keys are SHA-256 hashed before storage.

The primary provider has a 3,000 ms deadline. Only a timeout or HTTP 429 triggers the secondary provider. All failures use a stable gateway error envelope with a request ID; raw provider bodies and stack traces are never returned.

`sql.js` is used so the sample runs without a platform C++ compiler. Its lock protects one gateway process. Multiple replicas would need a shared transactional store or a distributed rate-limit service rather than a local SQLite file.

## Verification

```powershell
npm run check
```

The suite covers strict MCP error codes, a real stdio handshake, admin-call interception, downstream forwarding, PII split across stream chunks, Luhn handling, concurrent SQLite reservations, window eviction, provider fallback, usage reconciliation, and error sanitization.
