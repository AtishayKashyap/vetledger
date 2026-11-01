import type { ErrorRequestHandler, RequestHandler } from "express";
import type { Problem } from "@vetledger/shared";
import { ZodError } from "zod";

/** Errors that are safe to show the client. Anything else becomes a generic 500. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(detail ?? title);
  }
}

export const notFound = (what: string) => new AppError(404, "Not Found", `${what} not found`);
export const conflict = (detail: string, extra?: Record<string, unknown>) =>
  new AppError(409, "Conflict", detail, extra);

const slug = (title: string) => title.toLowerCase().replace(/[^a-z]+/g, "-");

/** Postgres error codes that map cleanly onto client errors. */
const PG_ERRORS: Record<string, [number, string]> = {
  "23505": [409, "Conflict"], // unique_violation
  "23503": [422, "Unprocessable Entity"], // foreign_key_violation (e.g. ownerId of another clinic)
  "23514": [422, "Unprocessable Entity"], // check_violation
  "42501": [403, "Forbidden"], // insufficient_privilege / RLS violation
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = String(req.id ?? "");
  let problem: Problem;
  if (err instanceof ZodError) {
    problem = {
      type: "about:blank#validation",
      title: "Validation failed",
      status: 400,
      errors: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    };
  } else if (err instanceof AppError) {
    problem = { type: `about:blank#${slug(err.title)}`, title: err.title, status: err.status, detail: err.detail, ...err.extra };
  } else if (typeof err?.code === "string" && err.code in PG_ERRORS) {
    const [status, title] = PG_ERRORS[err.code] as [number, string];
    // Constraint name only, never the raw SQL message (it can echo row values).
    problem = { type: `about:blank#${slug(title)}`, title, status, detail: err.constraint ? `constraint ${err.constraint}` : undefined };
  } else if (err?.type === "entity.too.large" || err?.type === "entity.parse.failed") {
    problem = { type: "about:blank#bad-request", title: "Bad Request", status: err.status ?? 400, detail: err.message };
  } else {
    req.log?.error({ err }, "unhandled error");
    problem = { type: "about:blank#internal", title: "Internal Server Error", status: 500 };
  }
  res.status(problem.status).type("application/problem+json").json({ ...problem, requestId });
};

export const notFoundHandler: RequestHandler = (req, _res, next) =>
  next(new AppError(404, "Not Found", `no route for ${req.method} ${req.path}`));
