import { afterEach, describe, expect, it, vi } from "vitest";

function storage() {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}
const json = (value: unknown, headers?: Record<string, string>, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("client attempt durability and historical response recovery", () => {
  it("retains the key across a lost response AND page/module reload, then waits for current state before returning replay", async () => {
    const store = storage();
    vi.stubGlobal("localStorage", store);
    const keys: string[] = [], sequence: string[] = [];
    let phase: "lost" | "replayed" = "lost";
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/me")) return json({ authenticated: true, user: { id: 42 } });
      if (init?.method === "GET") {
        sequence.push("current-state");
        return json({ status: "completed" });
      }
      keys.push(new Headers(init?.headers).get("Idempotency-Key")!);
      if (phase === "lost") throw new TypeError("connection lost after commit");
      sequence.push("historical-response");
      return json({ status: "accepted", replayed: true }, { "Idempotency-Replayed": "true" });
    });
    vi.stubGlobal("fetch", fetcher);
    let client = await import("../../../lib/api-client-react/src/custom-fetch");
    await client.customFetch("/api/auth/me");
    await expect(client.customFetch("/api/requests/1/accept", { method: "POST", body: "{}" })).rejects.toThrow("connection lost");
    expect(store.length).toBe(1); expect(keys[0]).toBeTruthy();
    // A new module simulates a reload; only persistent storage survives it.
    vi.resetModules();
    client = await import("../../../lib/api-client-react/src/custom-fetch");
    await client.customFetch("/api/auth/me");
    let currentStatus = "";
    client.setReplayHandler(async () => {
      currentStatus = (await client.customFetch<{ status: string }>("/api/requests/1", { method: "GET" })).status;
    });
    phase = "replayed";
    await client.customFetch("/api/requests/1/accept", { method: "POST", body: "{}" });
    sequence.push("mutation-callback");
    expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
    expect(currentStatus).toBe("completed");
    expect(sequence).toEqual(["historical-response", "current-state", "mutation-callback"]);
    expect(store.length).toBe(0);
  });
  it("separates users, retains uncertain server errors, and never adds business keys to auth/heartbeat", async () => {
    const store = storage(), seen: Array<{ url: string; key: string | null }> = [];
    vi.stubGlobal("localStorage", store);
    let userId = 1;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, key: new Headers(init?.headers).get("Idempotency-Key") });
      if (url.endsWith("/auth/me")) return json({ user: { id: userId } });
      if (url.endsWith("/heartbeat")) return json({ id: 1 });
      return json({ code: "INTERNAL_ERROR", message: "غير مؤكد" }, {}, 500);
    }));
    const client = await import("../../../lib/api-client-react/src/custom-fetch");
    await client.customFetch("/api/auth/me");
    await client.customFetch("/api/driver/trip/heartbeat", { method: "POST", body: '{"tripId":1}' });
    await expect(client.customFetch("/api/driver/trip/end", { method: "POST" })).rejects.toThrow();
    userId = 2; await client.customFetch("/api/auth/me");
    await expect(client.customFetch("/api/driver/trip/end", { method: "POST" })).rejects.toThrow();
    expect(store.length).toBe(2);
    expect(seen.filter((r) => /auth|heartbeat/.test(r.url)).every((r) => r.key === null)).toBe(true);
    expect(seen[2]!.key).not.toBe(seen[4]!.key);
  });
  it("keeps the attempt if current-state refetch fails, with no success callback", async () => {
    const store = storage(); vi.stubGlobal("localStorage", store);
    vi.stubGlobal("fetch", vi.fn(async () => json({ status: "accepted" }, { "Idempotency-Replayed": "true" })));
    const client = await import("../../../lib/api-client-react/src/custom-fetch");
    client.setReplayHandler(async () => { throw new TypeError("current state unavailable"); });
    await expect(client.customFetch("/api/requests/1/accept", { method: "POST" })).rejects.toThrow("current state unavailable");
    expect(store.length).toBe(1);
  });
  it("recovers the original occupancy payload after reload even when the displayed version has changed", async () => {
    const store = storage(); vi.stubGlobal("localStorage", store);
    const payload = JSON.stringify({ tripId: 4, externalOccupied: 2, expectedVersion: 5 });
    const calls: Array<{ key: string | null; body?: BodyInit | null }> = [];
    let lost = true;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/me")) return json({ user: { id: 7 } });
      calls.push({ key: new Headers(init?.headers).get("Idempotency-Key"), body: init?.body });
      if (lost) throw new TypeError("lost response");
      return json({ version: 6 }, { "Idempotency-Replayed": "true" });
    }));
    let client = await import("../../../lib/api-client-react/src/custom-fetch");
    await client.customFetch("/api/auth/me");
    await expect(client.customFetch("/api/driver/trip/external-occupancy", { method: "PATCH", body: payload })).rejects.toThrow();
    vi.resetModules();
    client = await import("../../../lib/api-client-react/src/custom-fetch");
    await client.customFetch("/api/auth/me");
    lost = false;
    await client.recoverPendingOperations();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[1]!.body).toBe(payload);
    expect(store.length).toBe(0);
  });
});
