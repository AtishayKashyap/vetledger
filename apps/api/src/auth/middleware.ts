import type { RequestHandler } from "express";
import type { Role } from "@vetledger/shared";
import { AppError } from "../http/errors.js";
import { verifyAccessToken } from "./tokens.js";

export function requireAuth(secret: string): RequestHandler {
  return (req, _res, next) => {
    const header = req.headers.authorization ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) return next(new AppError(401, "Unauthorized", "missing bearer token"));
    req.auth = verifyAccessToken(token, secret);
    req.log = req.log.child({ userId: req.auth.userId, clinicId: req.auth.clinicId });
    next();
  };
}

export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(new AppError(401, "Unauthorized"));
    if (!roles.includes(req.auth.role)) {
      return next(new AppError(403, "Forbidden", `requires role: ${roles.join(" or ")}`));
    }
    next();
  };
}

/** The authenticated caller. Throws 401 instead of trusting a non-null assertion. */
export function principal(req: Express.Request): NonNullable<Express.Request["auth"]> {
  if (!req.auth) throw new AppError(401, "Unauthorized");
  return req.auth;
}
