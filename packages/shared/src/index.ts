/**
 * Contracts shared by the API (request validation) and the web app (form validation
 * and response types). One source of truth means the client can never drift from
 * what the server accepts.
 */
import { z } from "zod";

export const ROLES = ["admin", "vet", "tech"] as const;
export type Role = (typeof ROLES)[number];

export const SPECIES = ["dog", "cat", "cattle", "sheep", "goat", "horse", "poultry", "other"] as const;
export type Species = (typeof SPECIES)[number];

const trimmed = (max: number) => z.string().trim().min(1).max(max);
const isoDate = z.iso.date();

/** Emails are case-insensitive in practice; normalise once, at the boundary. */
const email = z.email().max(254).transform((e) => e.toLowerCase());

export const loginSchema = z.object({
  email,
  password: z.string().min(8).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const ownerCreateSchema = z.object({
  fullName: trimmed(120),
  email: email.optional(),
  phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, "invalid phone number").optional(),
});
export type OwnerCreate = z.infer<typeof ownerCreateSchema>;

export const animalCreateSchema = z.object({
  ownerId: z.uuid(),
  name: trimmed(80),
  species: z.enum(SPECIES),
  breed: z.string().trim().max(80).optional(),
  sex: z.enum(["male", "female", "unknown"]).default("unknown"),
  birthDate: isoDate.optional(),
  weightKg: z.number().positive().max(2000).optional(),
  tagNumber: z.string().trim().max(40).optional(),
});
export type AnimalCreate = z.infer<typeof animalCreateSchema>;

// .partial() keeps defaults, so `sex` must be overridden: otherwise a PATCH that only
// changes weight would silently reset sex to "unknown" (caught by a test).
export const animalUpdateSchema = animalCreateSchema
  .omit({ ownerId: true })
  .partial()
  .extend({ sex: z.enum(["male", "female", "unknown"]).optional() });
export type AnimalUpdate = z.infer<typeof animalUpdateSchema>;

export const visitCreateSchema = z.object({
  animalId: z.uuid(),
  reason: trimmed(200),
  notes: z.string().trim().max(5000).optional(),
  weightKg: z.number().positive().max(2000).optional(),
  visitedAt: z.iso.datetime({ offset: true }).optional(),
});
export type VisitCreate = z.infer<typeof visitCreateSchema>;

export const vaccinationCreateSchema = z.object({
  animalId: z.uuid(),
  productId: z.uuid(),
  /** Days until the booster is due; creates a reminder when set. */
  boosterInDays: z.number().int().min(1).max(3650).optional(),
  administeredAt: z.iso.datetime({ offset: true }).optional(),
});
export type VaccinationCreate = z.infer<typeof vaccinationCreateSchema>;

export const productCreateSchema = z.object({
  sku: z.string().trim().regex(/^[A-Z0-9-]{2,30}$/, "SKU must be A-Z, 0-9 or -"),
  name: trimmed(120),
  kind: z.enum(["drug", "vaccine"]),
  unit: z.enum(["dose", "ml", "tablet", "vial"]),
  reorderLevel: z.number().int().min(0).max(1_000_000).default(0),
});
export type ProductCreate = z.infer<typeof productCreateSchema>;

export const batchReceiveSchema = z.object({
  productId: z.uuid(),
  lotNumber: z.string().trim().min(1).max(40),
  expiresOn: isoDate,
  quantity: z.number().int().positive().max(1_000_000),
});
export type BatchReceive = z.infer<typeof batchReceiveSchema>;

export const prescriptionCreateSchema = z.object({
  animalId: z.uuid(),
  productId: z.uuid(),
  quantity: z.number().int().positive().max(10_000),
  instructions: z.string().trim().max(1000).optional(),
});
export type PrescriptionCreate = z.infer<typeof prescriptionCreateSchema>;

export const listQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

/** RFC 9457 problem+json body returned by every API error. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  errors?: { path: string; message: string }[];
  requestId?: string;
}
