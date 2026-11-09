import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_BYTES = 1024 * 1024;

export async function readJsonBody(
  request: IncomingMessage,
  maxBytes = MAX_BODY_BYTES,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new HttpInputError(413, "Request body is too large.");
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpInputError(400, "Request body is not valid JSON.");
  }
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
  });
  response.end(encoded);
}

export class HttpInputError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function listen(
  server: import("node:http").Server,
  port: number,
  host = "127.0.0.1",
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export async function writeWithBackpressure(
  response: ServerResponse,
  data: string | Uint8Array,
): Promise<void> {
  if (response.write(data)) return;
  await new Promise<void>((resolve, reject) => {
    response.once("drain", resolve);
    response.once("error", reject);
  });
}
