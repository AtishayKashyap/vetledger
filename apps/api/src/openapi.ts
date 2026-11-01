/**
 * OpenAPI 3.1 document generated from the same Zod schemas that validate requests
 * (zod v4's native JSON Schema export), so the docs can't drift from the code.
 */
import * as s from "@vetledger/shared";
import { z } from "zod";

const body = (schema: z.ZodType) => ({
  required: true,
  content: { "application/json": { schema: z.toJSONSchema(schema, { io: "input" }) } },
});
const problem = { description: "Problem details (RFC 9457)", content: { "application/problem+json": {} } };
const idem = { name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", minLength: 8 } };
const write = (summary: string, schema: z.ZodType, roles?: string) => ({
  summary: roles ? `${summary} (${roles})` : summary,
  parameters: [idem],
  requestBody: body(schema),
  responses: { "201": { description: "Created" }, "400": problem, "403": problem, "409": problem },
});
const read = (summary: string) => ({ summary, responses: { "200": { description: "OK" }, "401": problem } });

export const openapi = {
  openapi: "3.1.0",
  info: { title: "vetledger API", version: "0.1.0", description: "REST write API. Reads for dashboards are also available at POST /api/graphql." },
  components: { securitySchemes: { bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
  security: [{ bearer: [] }],
  paths: {
    "/api/auth/login": { post: { summary: "Log in", security: [], requestBody: body(s.loginSchema), responses: { "200": { description: "Access token + refresh cookie" }, "401": problem, "429": problem } } },
    "/api/auth/refresh": { post: { summary: "Rotate refresh token (requires X-Requested-With: vetledger)", security: [], responses: { "200": { description: "New access token" }, "401": problem } } },
    "/api/auth/logout": { post: { summary: "Revoke the refresh-token family", security: [], responses: { "204": { description: "Logged out" } } } },
    "/api/owners": { get: read("List owners"), post: write("Create owner", s.ownerCreateSchema) },
    "/api/animals": { get: read("List animals (keyset pagination via ?cursor)"), post: write("Register animal", s.animalCreateSchema) },
    "/api/animals/{id}": {
      get: read("Get animal (returns ETag)"),
      patch: {
        summary: "Update animal; requires If-Match: <version> (optimistic concurrency)",
        parameters: [{ name: "If-Match", in: "header", required: true, schema: { type: "string" } }],
        requestBody: body(s.animalUpdateSchema),
        responses: { "200": { description: "Updated" }, "409": problem, "428": problem },
      },
    },
    "/api/visits": { post: write("Record visit", s.visitCreateSchema, "vet, admin") },
    "/api/vaccinations": { post: write("Administer vaccine (FEFO, schedules reminder)", s.vaccinationCreateSchema, "vet, tech") },
    "/api/prescriptions": { post: write("Prescribe and dispense (FEFO)", s.prescriptionCreateSchema, "vet") },
    "/api/products": { get: read("Products with live stock"), post: write("Create product", s.productCreateSchema, "admin") },
    "/api/batches": { post: write("Receive stock batch", s.batchReceiveSchema, "admin") },
    "/api/batches/{id}/recipients": { get: read("Recall trace: animals that received this batch") },
    "/api/reminders": { get: read("Reminders + queue depth") },
    "/api/reminders/{id}/retry": { post: { summary: "Retry a dead-lettered reminder (admin)", responses: { "202": { description: "Re-queued" }, "409": problem } } },
    "/api/audit": { get: read("Append-only audit log (admin)") },
  },
} as const;
