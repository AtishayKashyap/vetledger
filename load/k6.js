// Equivalent scenario for k6 users:  k6 run -e BASE=http://localhost:4000 load/k6.js
import http from "k6/http";
import { check } from "k6";

export const options = {
  vus: 20,
  duration: "30s",
  thresholds: { http_req_failed: ["rate<0.01"], http_req_duration: ["p(95)<150"] },
};

const BASE = __ENV.BASE || "http://localhost:4000";

export function setup() {
  const res = http.post(`${BASE}/api/auth/login`, JSON.stringify({ email: "vet@sunrise.vet", password: "vetledger-demo" }), {
    headers: { "content-type": "application/json" },
  });
  return { token: res.json("accessToken") };
}

export default function (data) {
  const headers = { authorization: `Bearer ${data.token}`, "content-type": "application/json" };
  check(http.get(`${BASE}/api/animals?limit=20`, { headers }), { "animals 200": (r) => r.status === 200 });
  check(http.post(`${BASE}/api/graphql`, JSON.stringify({ query: "{ dashboard { stats { animals } lowStock { sku } } }" }), { headers }), {
    "dashboard 200": (r) => r.status === 200,
  });
}
