import { createHash, randomBytes, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { sql } from "kysely";
import type { Role } from "@vetledger/shared";
import type { Db } from "../db.js";
import { AppError } from "../http/errors.js";

const ISSUER = "vetledger";
const AUDIENCE = "vetledger-api";

export interface Principal {
  userId: string;
  clinicId: string;
  role: Role;
}

export function signAccessToken(p: Principal, secret: string, ttlSec: number): string {
  return jwt.sign({ cid: p.clinicId, role: p.role }, secret, {
    algorithm: "HS256",
    subject: p.userId,
    expiresIn: ttlSec,
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

export function verifyAccessToken(token: string, secret: string): Principal {
  try {
    // Pin the algorithm: never let the token header choose it ("alg: none" attacks).
    const claims = jwt.verify(token, secret, { algorithms: ["HS256"], issuer: ISSUER, audience: AUDIENCE });
    if (typeof claims === "string" || !claims.sub) throw new Error("malformed");
    return { userId: claims.sub, clinicId: String(claims.cid), role: claims.role as Role };
  } catch {
    throw new AppError(401, "Unauthorized", "invalid or expired access token");
  }
}

const hashToken = (token: string) => createHash("sha256").update(token).digest();

/** Issue a new opaque refresh token. Only its SHA-256 is stored: a DB leak yields no usable tokens. */
export async function issueRefreshToken(db: Db, userId: string, ttlDays: number, familyId = randomUUID()) {
  const token = randomBytes(32).toString("base64url");
  await db
    .insertInto("refresh_tokens")
    .values({
      user_id: userId,
      family_id: familyId,
      token_hash: hashToken(token),
      expires_at: new Date(Date.now() + ttlDays * 86_400_000),
    })
    .execute();
  return { token, familyId };
}

export type RotateResult =
  | { ok: true; userId: string; token: string }
  | { ok: false; reason: "unknown" | "expired" | "revoked" | "reused" };

/**
 * Refresh-token rotation with reuse detection (OAuth 2.0 Security BCP §4.14).
 * Each token is single-use. If an already-rotated token is presented, someone holds a
 * stolen copy: we revoke the entire family, logging out both the thief and the user.
 */
export async function rotateRefreshToken(db: Db, token: string, ttlDays: number): Promise<RotateResult> {
  return db.transaction().execute(async (tx) => {
    const row = await tx
      .selectFrom("refresh_tokens")
      .selectAll()
      .where("token_hash", "=", hashToken(token))
      .forUpdate() // serialise concurrent refreshes of the same token
      .executeTakeFirst();
    if (!row) return { ok: false, reason: "unknown" } as const;
    if (row.revoked_at) return { ok: false, reason: "revoked" } as const;
    if (row.rotated_at) {
      await tx
        .updateTable("refresh_tokens")
        .set({ revoked_at: sql`now()` })
        .where("family_id", "=", row.family_id)
        .where("revoked_at", "is", null)
        .execute();
      return { ok: false, reason: "reused" } as const;
    }
    if (row.expires_at.getTime() <= Date.now()) return { ok: false, reason: "expired" } as const;

    await tx.updateTable("refresh_tokens").set({ rotated_at: sql`now()` }).where("id", "=", row.id).execute();
    const next = randomBytes(32).toString("base64url");
    await tx
      .insertInto("refresh_tokens")
      .values({
        user_id: row.user_id,
        family_id: row.family_id,
        token_hash: hashToken(next),
        expires_at: new Date(Date.now() + ttlDays * 86_400_000),
      })
      .execute();
    return { ok: true, userId: row.user_id, token: next } as const;
  });
}

export async function revokeRefreshFamily(db: Db, token: string): Promise<void> {
  const row = await db
    .selectFrom("refresh_tokens")
    .select("family_id")
    .where("token_hash", "=", hashToken(token))
    .executeTakeFirst();
  if (!row) return;
  await db
    .updateTable("refresh_tokens")
    .set({ revoked_at: sql`now()` })
    .where("family_id", "=", row.family_id)
    .where("revoked_at", "is", null)
    .execute();
}
