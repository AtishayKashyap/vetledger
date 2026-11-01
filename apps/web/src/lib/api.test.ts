import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, login, refreshSession } from "./api";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const user = { id: "u", clinicId: "c", role: "vet", fullName: "V" };

afterEach(() => vi.unstubAllGlobals());

describe("api client", () => {
  it("refreshes once on 401 and retries with the new token", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${url} ${(init?.headers as Record<string, string> | undefined)?.authorization ?? ""}`);
      if (url === "/api/auth/login") return json(200, { accessToken: "old", user });
      if (url === "/api/auth/refresh") return json(200, { accessToken: "new", user });
      if (url === "/api/animals" && calls.filter((c) => c.startsWith("/api/animals")).length === 1) return json(401, { title: "Unauthorized", status: 401 });
      return json(200, { ok: true });
    }));
    await login("a@b.vet", "password123");
    expect(await api("/animals")).toEqual({ ok: true });
    expect(calls).toEqual(["/api/auth/login ", "/api/animals Bearer old", "/api/auth/refresh ", "/api/animals Bearer new"]);
  });

  it("shares one in-flight refresh between concurrent callers (avoids false reuse detection)", async () => {
    const fetchMock = vi.fn(async () => { await new Promise((r) => setTimeout(r, 5)); return json(200, { accessToken: "t", user }); });
    vi.stubGlobal("fetch", fetchMock);
    const [a, b, c] = await Promise.all([refreshSession(), refreshSession(), refreshSession()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(user);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("surfaces problem+json details as ApiError and sends idempotency keys", async () => {
    const fetchMock = vi.fn(async () => json(409, { title: "Insufficient Stock", status: 409, detail: "requested 9, available 8" }));
    vi.stubGlobal("fetch", fetchMock);
    const err = await api("/prescriptions", { body: { x: 1 }, idempotencyKey: "k-12345678" }, true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).message).toBe("requested 9, available 8");
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBe("k-12345678");
  });
});
