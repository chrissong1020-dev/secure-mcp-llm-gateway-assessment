import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import initSqlJs, { type Database } from "sql.js";

export interface RateLimitReservation {
  allowed: true;
  reservationId: string;
  remainingTokens: number;
}

export interface RateLimitRejection {
  allowed: false;
  remainingTokens: 0;
  retryAfterMs: number;
}

export class SlidingWindowRateLimiter {
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly database: Database,
    private readonly databasePath: string,
    private readonly limit = 50_000,
    private readonly windowMs = 60_000,
  ) {
    this.database.run(`
      CREATE TABLE IF NOT EXISTS token_usage (
        reservation_id TEXT PRIMARY KEY,
        tenant_key TEXT NOT NULL,
        used_at_ms INTEGER NOT NULL,
        tokens INTEGER NOT NULL CHECK (tokens > 0)
      );
      CREATE INDEX IF NOT EXISTS token_usage_tenant_time
        ON token_usage (tenant_key, used_at_ms);
    `);
    this.persist();
  }

  static async open(
    databasePath: string,
    limit = 50_000,
    windowMs = 60_000,
  ): Promise<SlidingWindowRateLimiter> {
    mkdirSync(dirname(databasePath), { recursive: true });
    const SQL = await initSqlJs();
    const database = existsSync(databasePath)
      ? new SQL.Database(readFileSync(databasePath))
      : new SQL.Database();
    return new SlidingWindowRateLimiter(database, databasePath, limit, windowMs);
  }

  async reserve(
    tenantKey: string,
    requestedTokens: number,
    now = Date.now(),
  ): Promise<RateLimitReservation | RateLimitRejection> {
    const tokens = Math.ceil(requestedTokens);
    if (!tenantKey || !Number.isSafeInteger(tokens) || tokens <= 0) {
      throw new TypeError("tenantKey and a positive integer token count are required");
    }

    return this.exclusive(() => {
      this.database.run("DELETE FROM token_usage WHERE used_at_ms <= ?", [
        now - this.windowMs,
      ]);

      const statement = this.database.prepare(
        `SELECT used_at_ms, tokens
           FROM token_usage
          WHERE tenant_key = ?
          ORDER BY used_at_ms ASC`,
      );
      statement.bind([tenantKey]);
      const rows: Array<{ used_at_ms: number; tokens: number }> = [];
      while (statement.step()) {
        const row = statement.getAsObject();
        rows.push({
          used_at_ms: Number(row.used_at_ms),
          tokens: Number(row.tokens),
        });
      }
      statement.free();
      const used = rows.reduce((total, row) => total + row.tokens, 0);

      if (used + tokens > this.limit) {
        const mustExpire = used + tokens - this.limit;
        let expiredTokens = 0;
        let retryAfterMs = this.windowMs;
        for (const row of rows) {
          expiredTokens += row.tokens;
          if (expiredTokens >= mustExpire) {
            retryAfterMs = Math.max(1, row.used_at_ms + this.windowMs - now);
            break;
          }
        }
        return { allowed: false, remainingTokens: 0, retryAfterMs };
      }

      const reservationId = randomUUID();
      this.database.run(
        `INSERT INTO token_usage (reservation_id, tenant_key, used_at_ms, tokens)
         VALUES (?, ?, ?, ?)`,
        [reservationId, tenantKey, now, tokens],
      );
      return {
        allowed: true,
        reservationId,
        remainingTokens: this.limit - used - tokens,
      };
    }, true);
  }

  async reconcile(reservationId: string, actualTokens: number): Promise<void> {
    const tokens = Math.max(1, Math.ceil(actualTokens));
    await this.exclusive(() => {
      this.database.run(
        "UPDATE token_usage SET tokens = ? WHERE reservation_id = ?",
        [tokens, reservationId],
      );
    }, true);
  }

  async release(reservationId: string): Promise<void> {
    await this.exclusive(() => {
      this.database.run("DELETE FROM token_usage WHERE reservation_id = ?", [reservationId]);
    }, true);
  }

  close(): void {
    this.database.close();
  }

  private async exclusive<T>(work: () => T, shouldPersist = false): Promise<T> {
    const previous = this.queue;
    let unlock!: () => void;
    this.queue = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      const result = work();
      if (shouldPersist) this.persist();
      return result;
    } finally {
      unlock();
    }
  }

  private persist(): void {
    const temporaryPath = `${this.databasePath}.tmp`;
    writeFileSync(temporaryPath, this.database.export());
    renameSync(temporaryPath, this.databasePath);
  }
}
