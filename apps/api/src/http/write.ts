import { createHash } from "node:crypto";
import { principal } from "../auth/middleware.js";
import type { Request } from "express";
import { withTenant, type Db, type Tx } from "../db.js";
import { AppError } from "./errors.js";

export interface WriteResult<T> {
  status: number;
  body: T;
  /** True when the response was replayed from a stored Idempotency-Key. */
  replayed?: boolean;
}

/** Stable hash of method + path + body: a reused key with a different payload is a client bug. */
export function requestHash(req: Pick<Request, "method" | "originalUrl" | "body">): string {
  return createHash("sha256")
    .update(`${req.method} ${req.originalUrl}\n${JSON.stringify(req.body ?? null)}`)
    .digest("hex");
}

/**
 * Every tenant write goes through here: one transaction that
 *   1. scopes the connection to the caller's clinic (RLS),
 *   2. replays the stored response if the Idempotency-Key was seen before,
 *   3. runs the handler,
 *   4. stores the response under the key, atomically with the write itself.
 *
 * Two concurrent requests with the same new key both run the handler, but only one
 * can insert the key (primary key); the other's transaction rolls back entirely, so
 * the side effect happens exactly once.
 */
export async function tenantWrite<T>(
  db: Db,
  req: Request,
  fn: (tx: Tx) => Promise<WriteResult<T>>,
): Promise<WriteResult<T>> {
  const clinicId = principal(req).clinicId;
  const key = req.get("Idempotency-Key");
  if (key !== undefined && (key.length < 8 || key.length > 200)) {
    throw new AppError(400, "Bad Request", "Idempotency-Key must be 8-200 characters");
  }
  try {
    return await withTenant(db, clinicId, async (tx) => {
      if (key) {
        const prior = await tx
          .selectFrom("idempotency_keys")
          .select(["request_hash", "status_code", "response"])
          .where("key", "=", key)
          .executeTakeFirst();
        if (prior) {
          if (prior.request_hash !== requestHash(req)) {
            throw new AppError(422, "Unprocessable Entity", "Idempotency-Key was already used with a different request");
          }
          return { status: prior.status_code, body: prior.response as T, replayed: true };
        }
      }
      const result = await fn(tx);
      if (key) {
        await tx
          .insertInto("idempotency_keys")
          .values({ key, request_hash: requestHash(req), status_code: result.status, response: JSON.stringify(result.body) })
          .execute();
      }
      return result;
    });
  } catch (err) {
    if (key && (err as { code?: string; constraint?: string }).constraint === "idempotency_keys_pkey") {
      throw new AppError(409, "Conflict", "a request with this Idempotency-Key is already being processed; retry");
    }
    throw err;
  }
}

export async function audit(
  tx: Tx,
  req: Request,
  action: string,
  entity: string,
  entityId: string | null,
  data: Record<string, unknown> = {},
): Promise<void> {
  await tx
    .insertInto("audit_log")
    .values({
      actor_id: req.auth?.userId ?? null,
      action,
      entity,
      entity_id: entityId,
      data: JSON.stringify(data),
      request_id: String(req.id ?? ""),
    })
    .execute();
}

export function send<T>(res: import("express").Response, r: WriteResult<T>): void {
  if (r.replayed) res.setHeader("Idempotent-Replayed", "true");
  res.status(r.status).json(r.body);
}
