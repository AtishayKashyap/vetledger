/**
 * Demo data: two clinics (to make tenant isolation visible), staff for each role,
 * owners, animals, stock with staggered expiries, visit history, vaccinations and
 * reminders (some due today so the worker has work immediately).
 *
 * Runs as the OWNER role (clinics and users can't be created by the app role).
 * Deterministic PRNG so screenshots and tests are reproducible.
 */
import { sql } from "kysely";
import { hashPassword } from "./auth/password.js";
import { createDb, migrationDatabaseUrl, type Db } from "./db.js";

export const DEMO_PASSWORD = "vetledger-demo";

function prng(seed: number) {
  return () => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

const FIRST = ["Asha", "Ravi", "Meera", "Arjun", "Kiran", "Sana", "Vikram", "Neha", "Rahul", "Divya", "Imran", "Priya"];
const LAST = ["Rao", "Sharma", "Reddy", "Iyer", "Khan", "Patel", "Nair", "Gupta"];
const PET_NAMES = ["Bruno", "Coco", "Max", "Luna", "Simba", "Daisy", "Rocky", "Milo", "Bella", "Tiger", "Ganga", "Lakshmi", "Nandi", "Moti", "Chintu"];
const BREEDS: Record<string, string[]> = {
  dog: ["Labrador", "Indie", "German Shepherd", "Beagle"],
  cat: ["Persian", "Indie", "Siamese"],
  cattle: ["Gir", "Sahiwal", "Holstein Friesian"],
  goat: ["Jamunapari", "Barbari"],
};
const WEIGHT: Record<string, [number, number]> = { dog: [8, 40], cat: [3, 6], cattle: [300, 650], goat: [25, 60] };

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

export async function seed(db: Db, opts: { animalsPerClinic?: number } = {}): Promise<void> {
  const rand = prng(42);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  await db.transaction().execute(async (tx) => {
    // audit_log is append-only for the app (trigger). Only the owner, only for demo
    // reseeding, may suspend that, and it covers the CASCADE from clinics too.
    await sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update`.execute(tx);
    await sql`TRUNCATE clinics, users, refresh_tokens, owners, animals, visits, products, batches, prescriptions,
      dispense_allocations, vaccinations, reminders, idempotency_keys, audit_log CASCADE`.execute(tx);
    await sql`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update`.execute(tx);

    const clinics = await tx.insertInto("clinics")
      .values([{ name: "Sunrise Veterinary Hospital", slug: "sunrise" }, { name: "Deccan Livestock Clinic", slug: "deccan" }])
      .returning(["id", "slug"]).execute();

    for (const clinic of clinics) {
      const staff = await tx.insertInto("users").values([
        { clinic_id: clinic.id, email: `admin@${clinic.slug}.vet`, full_name: "Dr. Kavya Menon", role: "admin", password_hash: passwordHash },
        { clinic_id: clinic.id, email: `vet@${clinic.slug}.vet`, full_name: "Dr. Arjun Rao", role: "vet", password_hash: passwordHash },
        { clinic_id: clinic.id, email: `tech@${clinic.slug}.vet`, full_name: "Sana Khan", role: "tech", password_hash: passwordHash },
      ]).returning(["id", "role"]).execute();
      const vet = staff.find((s) => s.role === "vet")!;

      const products = await tx.insertInto("products").values([
        { clinic_id: clinic.id, sku: "VAC-RAB", name: "Rabies vaccine", kind: "vaccine", unit: "dose", reorder_level: 20 },
        { clinic_id: clinic.id, sku: "VAC-DHPP", name: "DHPP (canine 5-in-1)", kind: "vaccine", unit: "dose", reorder_level: 15 },
        { clinic_id: clinic.id, sku: "VAC-FMD", name: "Foot-and-mouth disease vaccine", kind: "vaccine", unit: "dose", reorder_level: 50 },
        { clinic_id: clinic.id, sku: "DRG-AMOX", name: "Amoxicillin 250 mg", kind: "drug", unit: "tablet", reorder_level: 100 },
        { clinic_id: clinic.id, sku: "DRG-MELOX", name: "Meloxicam 1.5 mg/ml", kind: "drug", unit: "ml", reorder_level: 200 },
        { clinic_id: clinic.id, sku: "DRG-IVER", name: "Ivermectin 1%", kind: "drug", unit: "ml", reorder_level: 150 },
      ]).returning(["id", "sku"]).execute();
      const bySku = Object.fromEntries(products.map((p) => [p.sku, p.id]));

      // Staggered expiries: one batch expiring soon (FEFO should drain it first), one
      // long-dated, and one already expired (must never be dispensed).
      const batchRows = products.flatMap((p, i) => [
        { clinic_id: clinic.id, product_id: p.id, lot_number: `L${24 + i}A`, expires_on: day(20 + i * 7), quantity: p.sku === "DRG-IVER" ? 40 : 30 },
        { clinic_id: clinic.id, product_id: p.id, lot_number: `L${25 + i}B`, expires_on: day(300), quantity: p.sku === "VAC-FMD" ? 12 : 200 },
        { clinic_id: clinic.id, product_id: p.id, lot_number: `L${23 + i}X`, expires_on: day(-10), quantity: 5 },
      ]);
      const batches = await tx.insertInto("batches").values(batchRows).returning(["id", "product_id", "expires_on"]).execute();
      const firstBatch = (productId: string) => batches.filter((b) => b.product_id === productId && b.expires_on >= day(0)).sort((a, b) => a.expires_on.localeCompare(b.expires_on))[0]!;

      const owners = await tx.insertInto("owners").values(
        Array.from({ length: 12 }, (_, i) => ({
          clinic_id: clinic.id,
          full_name: `${FIRST[(i + (clinic.slug === "deccan" ? 5 : 0)) % FIRST.length]} ${pick(LAST)}`,
          email: rand() < 0.85 ? `owner${i}@${clinic.slug}.example.com` : null,
          phone: `+91 9${Math.floor(rand() * 1e9).toString().padStart(9, "0")}`,
        })),
      ).returning("id").execute();

      const speciesMix = clinic.slug === "deccan" ? ["cattle", "cattle", "goat", "dog"] : ["dog", "dog", "cat", "cattle"];
      const n = opts.animalsPerClinic ?? 30;
      const animals = await tx.insertInto("animals").values(
        Array.from({ length: n }, (_, i) => {
          const species = pick(speciesMix);
          const [lo, hi] = WEIGHT[species]!;
          return {
            clinic_id: clinic.id,
            owner_id: pick(owners).id,
            name: PET_NAMES[i % PET_NAMES.length]! + (i >= PET_NAMES.length ? ` ${Math.floor(i / PET_NAMES.length) + 1}` : ""),
            species,
            breed: pick(BREEDS[species]!),
            sex: pick(["male", "female"] as const),
            birth_date: day(-Math.floor(200 + rand() * 2500)),
            weight_kg: Math.round((lo + rand() * (hi - lo)) * 10) / 10,
            tag_number: species === "cattle" || species === "goat" ? `TG-${1000 + i}` : null,
            created_at: new Date(Date.now() - (n - i) * 3_600_000 * 7),
          };
        }),
      ).returning(["id", "species"]).execute();

      const reasons = ["Annual check-up", "Limping on hind leg", "Skin irritation", "Vaccination visit", "Reduced appetite", "Mastitis follow-up", "Deworming"];
      await tx.insertInto("visits").values(
        animals.flatMap((a) => Array.from({ length: 1 + Math.floor(rand() * 4) }, () => ({
          clinic_id: clinic.id, animal_id: a.id, vet_id: vet.id, reason: pick(reasons),
          visited_at: new Date(Date.now() - Math.floor(rand() * 180) * 86_400_000),
        }))),
      ).execute();

      // Vaccinations with boosters; spread reminder due dates from 3 days ago to +40 days.
      for (const [i, a] of animals.entries()) {
        const sku = a.species === "cattle" || a.species === "goat" ? "VAC-FMD" : i % 2 ? "VAC-RAB" : "VAC-DHPP";
        const batch = firstBatch(bySku[sku]!);
        const due = day(-3 + (i % 15) * 3);
        const v = await tx.insertInto("vaccinations").values({
          clinic_id: clinic.id, animal_id: a.id, product_id: bySku[sku]!, batch_id: batch.id,
          administered_by: vet.id, administered_at: new Date(Date.now() - 330 * 86_400_000), next_due_on: due,
        }).returning("id").executeTakeFirstOrThrow();
        await tx.insertInto("dispense_allocations").values({ clinic_id: clinic.id, vaccination_id: v.id, batch_id: batch.id, quantity: 1 }).execute();
        await tx.insertInto("reminders").values({ clinic_id: clinic.id, vaccination_id: v.id, animal_id: a.id, due_on: due }).execute();
      }
      await tx.insertInto("audit_log").values({ clinic_id: clinic.id, action: "seed", entity: "clinic", entity_id: clinic.id, data: JSON.stringify({ animals: n }) }).execute();
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { db } = createDb(migrationDatabaseUrl(process.env), 2);
  await seed(db);
  await db.destroy();
  console.log(`seeded. log in as admin@sunrise.vet / vet@sunrise.vet / tech@sunrise.vet, password: ${DEMO_PASSWORD}`);
}
