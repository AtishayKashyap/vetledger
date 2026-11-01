/**
 * Load test for the read paths a clinic dashboard hits most.
 *   node load/bench.mjs [baseUrl] [durationSec] [connections]
 * Logs in as a seeded vet, then hammers each endpoint and prints p50/p95/p99 and RPS.
 * Uses autocannon (npm), so it runs anywhere Node does: no extra binary needed.
 */
import autocannon from "autocannon";

const BASE = process.argv[2] ?? "http://localhost:4000";
const DURATION = Number(process.argv[3] ?? 15);
const CONNECTIONS = Number(process.argv[4] ?? 20);

const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "vet@sunrise.vet", password: "vetledger-demo" }),
});
if (!login.ok) throw new Error(`login failed: ${login.status}`);
const { accessToken } = await login.json();
const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
const animals = await (await fetch(`${BASE}/api/animals?limit=1`, { headers })).json();
const animalId = animals.items[0].id;

const DASHBOARD = `{ dashboard { stats { animals pendingReminders } upcomingVaccinations(days: 14) { dueOn animal { name owner { fullName } } }
  lowStock { sku inStock } expiringBatches(days: 45) { lotNumber daysLeft } } }`;

const scenarios = [
  { name: "GET /api/animals?limit=20 (keyset page)", path: "/api/animals?limit=20" },
  { name: "GET /api/animals/:id", path: `/api/animals/${animalId}` },
  { name: "GET /api/products (stock aggregates)", path: "/api/products" },
  { name: "POST /api/graphql (full dashboard)", path: "/api/graphql", method: "POST", body: JSON.stringify({ query: DASHBOARD }) },
];

const rows = [];
for (const s of scenarios) {
  const r = await autocannon({
    url: BASE + s.path, method: s.method ?? "GET", headers, body: s.body,
    duration: DURATION, connections: CONNECTIONS,
  });
  const non2xx = r.non2xx + r.errors;
  rows.push({ scenario: s.name, "req/s": Math.round(r.requests.average), "p50 ms": r.latency.p50, "p90 ms": r.latency.p90, "p97.5 ms": r.latency.p97_5, "p99 ms": r.latency.p99, errors: non2xx });
}
console.table(rows);
console.log(JSON.stringify({ connections: CONNECTIONS, durationSec: DURATION, results: rows }));
