import { describe, expect, it } from "vitest";
import { redactOpenAiSse } from "../src/openai-sse-redactor.js";
import { StreamingRedactor } from "../src/streaming-redactor.js";

describe("streaming PII redaction", () => {
  it("redacts values split across arbitrary chunks", () => {
    const redactor = new StreamingRedactor();
    const output = [
      redactor.push("Email ali"),
      redactor.push("ce@example.com, SSN 123-"),
      redactor.push("45-6789 and card 4111 1111"),
      redactor.push(" 1111 1111."),
      redactor.flush(),
    ].join("");

    expect(output).toBe(
      "Email [REDACTED], SSN [REDACTED] and card [REDACTED].",
    );
  });

  it("does not redact a random 16-digit number that fails Luhn", () => {
    const redactor = new StreamingRedactor();
    const output = redactor.push("reference 1234 5678 9012 3456.") + redactor.flush();
    expect(output).toContain("1234 5678 9012 3456");
  });

  it("parses split SSE frames and flushes before [DONE]", async () => {
    const encoder = new TextEncoder();
    const parts = [
      'data: {"choices":[{"index":0,"delta":{"content":"alice@exa"}}]}\n',
      '\ndata: {"choices":[{"index":0,"delta":{"content":"mple.com"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
      },
    });

    let output = "";
    for await (const event of redactOpenAiSse(body)) output += event;
    expect(output).not.toContain("alice@example.com");
    expect(output).toContain("[REDACTED]");
    expect(output.indexOf("[REDACTED]")).toBeLessThan(output.indexOf("[DONE]"));
  });
});
