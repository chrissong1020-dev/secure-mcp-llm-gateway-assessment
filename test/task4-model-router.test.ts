import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelRouter } from "../src/model-router.js";
import { SlidingWindowRateLimiter } from "../src/sliding-window-rate-limiter.js";

const temporaryDirectories: string[] = [];
const limiters: SlidingWindowRateLimiter[] = [];

afterEach(() => {
  for (const limiter of limiters.splice(0)) limiter.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function limiter(limit = 50_000) {
  const directory = mkdtempSync(join(tmpdir(), "gateway-rate-limit-"));
  temporaryDirectories.push(directory);
  const instance = await SlidingWindowRateLimiter.open(
    join(directory, "usage.sqlite"),
    limit,
  );
  limiters.push(instance);
  return instance;
}

describe("SQLite sliding-window limiter", () => {
  it("serializes concurrent reservations atomically", async () => {
    const rateLimiter = await limiter(100);
    const results = await Promise.all([
      rateLimiter.reserve("tenant-a", 60, 1_000),
      rateLimiter.reserve("tenant-a", 60, 1_000),
    ]);
    expect(results.filter((result) => result.allowed)).toHaveLength(1);
  });

  it("evicts usage once it leaves the window", async () => {
    const rateLimiter = await limiter(100);
    expect((await rateLimiter.reserve("tenant-a", 100, 1_000)).allowed).toBe(true);
    expect((await rateLimiter.reserve("tenant-a", 1, 2_000)).allowed).toBe(false);
    expect((await rateLimiter.reserve("tenant-a", 100, 61_001)).allowed).toBe(true);
  });
});

describe("model fallback router", () => {
  it("falls back on 429 and reconciles the reservation with actual usage", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).includes("primary")) return new Response("busy", { status: 429 });
      return Response.json({ id: "ok", usage: { total_tokens: 12 } });
    };
    const rateLimiter = await limiter(100);
    const router = new ModelRouter({
      primary: { name: "primary", url: "https://primary.test", apiKey: "p" },
      secondary: { name: "secondary", url: "https://secondary.test", apiKey: "s" },
      limiter: rateLimiter,
      fetchImpl: fetchImpl as typeof fetch,
    });

    const result = await router.route("tenant-a", {
      prompt: "hello",
      max_tokens: 20,
    });
    expect(result.status).toBe(200);
    expect(result.headers?.["x-model-provider"]).toBe("secondary");
    expect(calls).toEqual(["https://primary.test", "https://secondary.test"]);
  });

  it("falls back after the deadline even if a provider ignores abort", async () => {
    const fetchImpl = async (url: string | URL | Request) => {
      if (String(url).includes("primary")) {
        return new Promise<Response>(() => undefined);
      }
      return Response.json({ id: "backup", usage: { total_tokens: 4 } });
    };
    const rateLimiter = await limiter(100);
    const router = new ModelRouter({
      primary: { name: "primary", url: "https://primary.test", apiKey: "p" },
      secondary: { name: "secondary", url: "https://secondary.test", apiKey: "s" },
      limiter: rateLimiter,
      timeoutMs: 10,
      fetchImpl: fetchImpl as typeof fetch,
    });

    const result = await router.route("tenant-a", {
      prompt: "hello",
      max_tokens: 10,
    });
    expect(result.status).toBe(200);
    expect(result.headers?.["x-model-provider"]).toBe("secondary");
  });

  it("sanitizes upstream failures", async () => {
    const rateLimiter = await limiter();
    const router = new ModelRouter({
      primary: { name: "primary", url: "https://primary.test", apiKey: "secret" },
      secondary: { name: "secondary", url: "https://secondary.test", apiKey: "secret" },
      limiter: rateLimiter,
      fetchImpl: (async () => new Response("raw stack and secret", { status: 500 })) as typeof fetch,
    });

    const result = await router.route("tenant-a", { prompt: "hello", max_tokens: 1 });
    expect(result.status).toBe(502);
    expect(JSON.stringify(result.body)).not.toMatch(/raw stack|secret/);
    expect(result.body).toEqual({
      error: {
        code: "MODEL_PROVIDER_ERROR",
        message: "The model provider could not complete the request.",
        request_id: expect.any(String),
      },
    });
  });
});
