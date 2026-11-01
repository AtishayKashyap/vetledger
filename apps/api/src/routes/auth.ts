import { Router, type CookieOptions, type Response } from "express";
import { sql } from "kysely";
import { loginSchema } from "@vetledger/shared";
import { principal, requireAuth } from "../auth/middleware.js";
import { DUMMY_HASH, verifyPassword } from "../auth/password.js";
import { issueRefreshToken, revokeRefreshFamily, rotateRefreshToken, signAccessToken, type Principal } from "../auth/tokens.js";
import type { Deps } from "../deps.js";
import { withTenant } from "../db.js";
import { AppError } from "../http/errors.js";

export const REFRESH_COOKIE = "vl_refresh";

export function authRouter({ db, config }: Deps): Router {
  const r = Router();
  const cookie: CookieOptions = {
    httpOnly: true, // unreadable by JS, so XSS can't exfiltrate it
    secure: config.COOKIE_SECURE,
    sameSite: "strict", // never sent cross-site, so refresh is CSRF-safe
    path: "/api/auth", // only sent to auth endpoints
    maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  };

  const respond = (res: Response, p: Principal & { fullName: string }, refresh: string) => {
    res.cookie(REFRESH_COOKIE, refresh, cookie);
    res.json({
      accessToken: signAccessToken(p, config.JWT_SECRET, config.ACCESS_TOKEN_TTL_SEC),
      expiresIn: config.ACCESS_TOKEN_TTL_SEC,
      user: { id: p.userId, clinicId: p.clinicId, role: p.role, fullName: p.fullName },
    });
  };

  r.post("/login", async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const { rows } = await sql<{ id: string; clinic_id: string; role: Principal["role"]; full_name: string; password_hash: string; is_active: boolean }>`
      SELECT * FROM auth_find_user(${email})`.execute(db);
    const user = rows[0];
    // Always run argon2 so response time doesn't reveal whether the email exists.
    const ok = await verifyPassword(user?.password_hash ?? (await DUMMY_HASH), password);
    if (!user || !ok || !user.is_active) {
      req.log.warn({ email }, "login failed");
      throw new AppError(401, "Unauthorized", "invalid email or password");
    }
    const { token } = await issueRefreshToken(db, user.id, config.REFRESH_TOKEN_TTL_DAYS);
    await withTenant(db, user.clinic_id, (tx) =>
      tx.insertInto("audit_log").values({ actor_id: user.id, action: "login", entity: "user", entity_id: user.id, data: "{}", request_id: String(req.id) }).execute(),
    );
    respond(res, { userId: user.id, clinicId: user.clinic_id, role: user.role, fullName: user.full_name }, token);
  });

  r.post("/refresh", async (req, res) => {
    // Require a custom header: browsers can't add one cross-site without a CORS preflight.
    if (req.get("X-Requested-With") !== "vetledger") throw new AppError(403, "Forbidden", "missing X-Requested-With");
    const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    // No cookie = anonymous visitor (e.g. first page load): not an error, just "no session".
    if (!token) {
      res.status(204).end();
      return;
    }
    const result = await rotateRefreshToken(db, token, config.REFRESH_TOKEN_TTL_DAYS);
    if (!result.ok) {
      if (result.reason === "reused") req.log.warn("refresh token reuse detected; family revoked");
      res.clearCookie(REFRESH_COOKIE, { ...cookie, maxAge: undefined });
      throw new AppError(401, "Unauthorized", `refresh token ${result.reason}`);
    }
    const { rows } = await sql<{ id: string; clinic_id: string; role: Principal["role"]; full_name: string; is_active: boolean }>`
      SELECT * FROM auth_user_by_id(${result.userId})`.execute(db);
    const user = rows[0];
    if (!user?.is_active) throw new AppError(401, "Unauthorized", "account disabled");
    respond(res, { userId: user.id, clinicId: user.clinic_id, role: user.role, fullName: user.full_name }, result.token);
  });

  r.post("/logout", async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (token) await revokeRefreshFamily(db, token);
    res.clearCookie(REFRESH_COOKIE, { ...cookie, maxAge: undefined });
    res.status(204).end();
  });

  r.get("/me", requireAuth(config.JWT_SECRET), async (req, res) => {
    const me = await withTenant(db, principal(req).clinicId, (tx) =>
      tx
        .selectFrom("users")
        .innerJoin("clinics", "clinics.id", "users.clinic_id")
        .select(["users.id", "users.email", "users.full_name as fullName", "users.role", "clinics.name as clinicName"])
        .where("users.id", "=", principal(req).userId)
        .executeTakeFirstOrThrow(),
    );
    res.json(me);
  });

  return r;
}
