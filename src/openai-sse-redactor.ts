import { StreamingRedactor } from "./streaming-redactor.js";

const MAX_EVENT_BYTES = 1024 * 1024;

/** Transforms OpenAI-compatible SSE while preserving event framing. */
export async function* redactOpenAiSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const redactors = new Map<number, StreamingRedactor>();
  let pending = "";

  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const { events, rest } = takeCompleteEvents(pending);
      pending = rest;
      if (pending.length > MAX_EVENT_BYTES) {
        throw new Error("Provider sent an oversized SSE event");
      }
      for (const event of events) {
        yield transformEvent(event, redactors);
      }
    }
  } finally {
    reader.releaseLock();
  }

  pending += decoder.decode();
  if (pending.trim()) yield transformEvent(pending, redactors);
  yield* flushRedactors(redactors);
}

function takeCompleteEvents(input: string): { events: string[]; rest: string } {
  const normalized = input.replace(/\r\n/g, "\n");
  const pieces = normalized.split("\n\n");
  const rest = pieces.pop() ?? "";
  return { events: pieces, rest };
}

function transformEvent(
  event: string,
  redactors: Map<number, StreamingRedactor>,
): string {
  const lines = event.split("\n");
  const dataLines = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) return `${event}\n\n`;

  const data = dataLines.join("\n");
  if (data === "[DONE]") {
    let output = "";
    for (const flushed of flushRedactors(redactors)) output += flushed;
    return `${output}data: [DONE]\n\n`;
  }

  try {
    const message = JSON.parse(data) as {
      choices?: Array<{
        index?: number;
        delta?: { content?: unknown; [key: string]: unknown };
        finish_reason?: unknown;
        [key: string]: unknown;
      }>;
    };
    for (const [position, choice] of (message.choices ?? []).entries()) {
      const index = choice.index ?? position;
      let redactor = redactors.get(index);
      if (typeof choice.delta?.content === "string") {
        redactor ??= new StreamingRedactor();
        redactors.set(index, redactor);
        choice.delta.content = redactor.push(choice.delta.content);
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        const finalContent = redactor?.flush() ?? "";
        if (finalContent) {
          choice.delta ??= {};
          choice.delta.content =
            (typeof choice.delta.content === "string" ? choice.delta.content : "") +
            finalContent;
        }
        redactors.delete(index);
      }
    }
    return `data: ${JSON.stringify(message)}\n\n`;
  } catch {
    // Non-JSON provider events (for example comments) pass through unchanged.
    return `${event}\n\n`;
  }
}

function* flushRedactors(
  redactors: Map<number, StreamingRedactor>,
): Generator<string> {
  for (const [index, redactor] of redactors) {
    const content = redactor.flush();
    if (!content) continue;
    yield `data: ${JSON.stringify({
      choices: [{ index, delta: { content } }],
    })}\n\n`;
  }
  redactors.clear();
}
