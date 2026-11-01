/**
 * API client. The access token lives only in memory (never localStorage, where any XSS
 * could read it); the refresh token is an httpOnly cookie the browser sends to
 * /api/auth only. On a 401 we refresh once and retry, and concurrent 401s share a
 * single in-flight refresh (a second parallel refresh would look like token reuse to
 * the server and revoke the session).
 */
import type { Problem, Role } from "@vetledger/shared";

export interface SessionUser {
  id: string;
  clinicId: string;
  role: Role;
  fullName: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem;
  constructor(problem: Problem) {
    super(problem.detail ?? problem.title);
    this.status = problem.status;
    this.problem = problem;
  }
}

let accessToken: string | null = null;
let refreshing: Promise<SessionUser | null> | null = null;
const listeners = new Set<(u: SessionUser | null) => void>();

export const onSessionChange = (fn: (u: SessionUser | null) => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
const emit = (u: SessionUser | null) => listeners.forEach((fn) => fn(u));

async function parse(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function toError(res: Response): Promise<ApiError> {
  const body = (await parse(res).catch(() => null)) as Problem | null;
  return new ApiError(body ?? { type: "about:blank", title: res.statusText || "Request failed", status: res.status });
}

export function refreshSession(): Promise<SessionUser | null> {
  refreshing ??= fetch("/api/auth/refresh", { method: "POST", headers: { "X-Requested-With": "vetledger" } })
    .then(async (res) => {
      if (!res.ok || res.status === 204) {
        accessToken = null;
        emit(null);
        return null;
      }
      const body = (await res.json()) as { accessToken: string; user: SessionUser };
      accessToken = body.accessToken;
      emit(body.user);
      return body.user;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export async function login(email: string, password: string): Promise<SessionUser> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw await toError(res);
  const body = (await res.json()) as { accessToken: string; user: SessionUser };
  accessToken = body.accessToken;
  emit(body.user);
  return body.user;
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
  accessToken = null;
  emit(null);
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Send an Idempotency-Key so a double-click or network retry can't double-dispense. */
  idempotencyKey?: string;
}

export async function api<T>(path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (res.status === 401 && !retried) {
    const user = await refreshSession();
    if (user) return api<T>(path, opts, true);
  }
  if (!res.ok) throw await toError(res);
  return (await parse(res)) as T;
}

export async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await api<{ data?: T; errors?: { message: string }[] }>("/graphql", { body: { query, variables } });
  if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join("; "));
  return res.data as T;
}

export const newIdempotencyKey = () => crypto.randomUUID();
