/**
 * GraphQL for the read-heavy dashboard. REST stays the write API (idempotency keys,
 * If-Match and HTTP caching semantics fit writes better); GraphQL lets the dashboard
 * fetch exactly the shape it renders in one round trip.
 *
 * N+1 protection: every relation goes through a per-request DataLoader, so listing 50
 * animals with owners, last visits and vaccinations costs 4 queries, not 151.
 */
import { ApolloServer } from "@apollo/server";
import { principal } from "../auth/middleware.js";
import { expressMiddleware } from "@as-integrations/express5";
import DataLoader from "dataloader";
import type { RequestHandler } from "express";
import { GraphQLError, type ASTNode, type ValidationRule } from "graphql";
import { sql } from "kysely";
import type { ControlledTransaction, Kysely } from "kysely";
import type { DB, Db } from "../db.js";
import { todayUtc } from "../services/inventory.js";

export const typeDefs = /* GraphQL */ `
  type Query {
    dashboard: Dashboard!
    animals(search: String, first: Int = 20): [Animal!]!
    animal(id: ID!): Animal
  }

  type Dashboard {
    stats: Stats!
    upcomingVaccinations(days: Int = 30): [UpcomingVaccination!]!
    lowStock: [StockAlert!]!
    expiringBatches(days: Int = 60): [ExpiringBatch!]!
  }

  type Stats {
    animals: Int!
    owners: Int!
    visitsLast30d: Int!
    vaccinationsLast30d: Int!
    pendingReminders: Int!
    failedReminders: Int!
  }

  type Animal {
    id: ID!
    name: String!
    species: String!
    breed: String
    weightKg: Float
    owner: Owner!
    "Most recent visits first."
    visits(limit: Int = 5): [Visit!]!
    vaccinations: [Vaccination!]!
  }

  type Owner {
    id: ID!
    fullName: String!
    phone: String
  }

  type Visit {
    id: ID!
    visitedAt: String!
    reason: String!
    vetName: String!
  }

  type Vaccination {
    id: ID!
    product: String!
    lotNumber: String!
    administeredAt: String!
    nextDueOn: String
  }

  type UpcomingVaccination {
    reminderId: ID!
    dueOn: String!
    status: String!
    animal: Animal!
  }

  type StockAlert {
    productId: ID!
    sku: String!
    name: String!
    inStock: Int!
    reorderLevel: Int!
  }

  type ExpiringBatch {
    batchId: ID!
    product: String!
    lotNumber: String!
    expiresOn: String!
    quantity: Int!
    daysLeft: Int!
  }
`;

interface AnimalRow { id: string; name: string; species: string; breed: string | null; weightKg: number | null; ownerId: string }
interface VisitRow { id: string; animalId: string; visitedAt: Date; reason: string; vetName: string }
interface VaccRow { id: string; animalId: string; product: string; lotNumber: string; administeredAt: Date; nextDueOn: string | null }

export interface GqlContext {
  clinicId: string;
  /** One READ ONLY transaction, scoped to the tenant, shared by every resolver of the request. */
  tx: ControlledTransaction<DB>;
  loaders: ReturnType<typeof createLoaders>;
}

/** Results must be returned in key order with one entry per key (DataLoader contract). */
function group<T>(keys: readonly string[], rows: T[], keyOf: (r: T) => string): T[][] {
  const m = new Map<string, T[]>(keys.map((k) => [k, []]));
  for (const r of rows) m.get(keyOf(r))?.push(r);
  return keys.map((k) => m.get(k) ?? []);
}

/** `q` must already be scoped to a tenant (see openTenantReadTx). */
export function createLoaders(q: Kysely<DB>) {
  const t = <R>(fn: (tx: Kysely<DB>) => Promise<R>) => fn(q);
  return {
    animal: new DataLoader<string, AnimalRow | null>(async (ids) => {
      const rows = await t((tx) =>
        tx.selectFrom("animals")
          .select(["id", "name", "species", "breed", "weight_kg as weightKg", "owner_id as ownerId"])
          .where("id", "in", [...ids]).execute());
      const m = new Map(rows.map((r) => [r.id, r]));
      return ids.map((id) => m.get(id) ?? null);
    }),
    owner: new DataLoader<string, { id: string; fullName: string; phone: string | null } | null>(async (ids) => {
      const rows = await t((tx) =>
        tx.selectFrom("owners").select(["id", "full_name as fullName", "phone"]).where("id", "in", [...ids]).execute());
      const m = new Map(rows.map((r) => [r.id, r]));
      return ids.map((id) => m.get(id) ?? null);
    }),
    /**
     * Top-N visits per animal in ONE query: ROW_NUMBER() partitioned by animal. A plain
     * `WHERE animal_id IN (...) LIMIT n` would cap the total, not the per-animal count.
     * Key is "animalId|limit" so different limits batch separately.
     */
    visits: new DataLoader<string, VisitRow[]>(async (keys) => {
      const byLimit = new Map<number, string[]>();
      for (const k of keys) {
        const [id = "", lim = "5"] = k.split("|");
        byLimit.set(Number(lim), [...(byLimit.get(Number(lim)) ?? []), id]);
      }
      const all: (VisitRow & { key: string })[] = [];
      for (const [limit, ids] of byLimit) {
        const rows = await t((tx) =>
          tx.selectFrom((eb) =>
            eb.selectFrom("visits as v").innerJoin("users as u", "u.id", "v.vet_id")
              .select(["v.id", "v.animal_id as animalId", "v.visited_at as visitedAt", "v.reason", "u.full_name as vetName",
                sql<number>`row_number() OVER (PARTITION BY v.animal_id ORDER BY v.visited_at DESC)`.as("rn")])
              .where("v.animal_id", "in", ids)
              .as("ranked"))
            .selectAll().where("rn", "<=", limit).orderBy("visitedAt", "desc").execute());
        all.push(...rows.map((r) => ({ ...r, key: `${r.animalId}|${limit}` })));
      }
      return group(keys, all, (r) => r.key);
    }),
    vaccinations: new DataLoader<string, VaccRow[]>(async (ids) => {
      const rows = await t((tx) =>
        tx.selectFrom("vaccinations as v")
          .innerJoin("products as p", "p.id", "v.product_id")
          .innerJoin("batches as b", "b.id", "v.batch_id")
          .select(["v.id", "v.animal_id as animalId", "p.name as product", "b.lot_number as lotNumber",
            "v.administered_at as administeredAt", "v.next_due_on as nextDueOn"])
          .where("v.animal_id", "in", [...ids]).orderBy("v.administered_at", "desc").execute());
      return group(ids, rows, (r) => r.animalId);
    }),
  };
}

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : d);

export const resolvers = {
  Query: {
    dashboard: () => ({}),
    animals: async (_: unknown, a: { search?: string | null; first: number }, ctx: GqlContext) => {
      const first = Math.min(Math.max(a.first, 1), 100);
      const rows = await (async (tx: Kysely<DB>) => {
        let q = tx.selectFrom("animals")
          .select(["id", "name", "species", "breed", "weight_kg as weightKg", "owner_id as ownerId"])
          .orderBy("created_at", "desc").limit(first);
        if (a.search) q = q.where(sql<boolean>`lower(name) LIKE ${`${a.search.toLowerCase()}%`}`);
        return q.execute();
      })(ctx.tx);
      rows.forEach((r) => ctx.loaders.animal.prime(r.id, r));
      return rows;
    },
    animal: (_: unknown, a: { id: string }, ctx: GqlContext) => ctx.loaders.animal.load(a.id),
  },
  Dashboard: {
    stats: async (_: unknown, __: unknown, ctx: GqlContext) => {
      const { rows } = await sql<Record<string, number>>`
          SELECT
            (SELECT count(*) FROM animals)::int AS animals,
            (SELECT count(*) FROM owners)::int AS owners,
            (SELECT count(*) FROM visits WHERE visited_at > now() - interval '30 days')::int AS "visitsLast30d",
            (SELECT count(*) FROM vaccinations WHERE administered_at > now() - interval '30 days')::int AS "vaccinationsLast30d",
            (SELECT count(*) FROM reminders WHERE status IN ('pending', 'queued'))::int AS "pendingReminders",
            (SELECT count(*) FROM reminders WHERE status = 'failed')::int AS "failedReminders"`.execute(ctx.tx);
      return rows[0];
    },
    upcomingVaccinations: async (_: unknown, a: { days: number }, ctx: GqlContext) => {
      const days = Math.min(Math.max(a.days, 1), 365);
      const rows = await ctx.tx.selectFrom("reminders")
          .select(["id as reminderId", "due_on as dueOn", "status", "animal_id as animalId"])
          .where("status", "in", ["pending", "queued", "failed"])
          .where(sql<boolean>`due_on <= current_date + ${days}::int`)
          .orderBy("due_on").limit(50).execute();
      return rows;
    },
    lowStock: async (_: unknown, __: unknown, ctx: GqlContext) => {
      const today = todayUtc();
      return ctx.tx.selectFrom("products as p").leftJoin("batches as b", (j) => j.onRef("b.product_id", "=", "p.id").on("b.expires_on", ">=", today))
          .select(["p.id as productId", "p.sku", "p.name", "p.reorder_level as reorderLevel",
            sql<number>`coalesce(sum(b.quantity), 0)::int`.as("inStock")])
          .groupBy("p.id")
          .having(sql<boolean>`coalesce(sum(b.quantity), 0) <= p.reorder_level`)
          .orderBy("p.name").execute();
    },
    expiringBatches: async (_: unknown, a: { days: number }, ctx: GqlContext) => {
      const days = Math.min(Math.max(a.days, 1), 365);
      return ctx.tx.selectFrom("batches as b").innerJoin("products as p", "p.id", "b.product_id")
          .select(["b.id as batchId", "p.name as product", "b.lot_number as lotNumber", "b.expires_on as expiresOn", "b.quantity",
            sql<number>`(b.expires_on - current_date)`.as("daysLeft")])
          .where("b.quantity", ">", 0)
          .where(sql<boolean>`b.expires_on BETWEEN current_date AND current_date + ${days}::int`)
          .orderBy("b.expires_on").limit(50).execute();
    },
  },
  UpcomingVaccination: {
    animal: (r: { animalId: string }, _: unknown, ctx: GqlContext) => ctx.loaders.animal.load(r.animalId),
  },
  Animal: {
    owner: (a: AnimalRow, _: unknown, ctx: GqlContext) => ctx.loaders.owner.load(a.ownerId),
    visits: async (a: AnimalRow, args: { limit: number }, ctx: GqlContext) =>
      (await ctx.loaders.visits.load(`${a.id}|${Math.min(Math.max(args.limit, 1), 50)}`)).map((v) => ({ ...v, visitedAt: iso(v.visitedAt) })),
    vaccinations: async (a: AnimalRow, _: unknown, ctx: GqlContext) =>
      (await ctx.loaders.vaccinations.load(a.id)).map((v) => ({ ...v, administeredAt: iso(v.administeredAt) })),
  },
};

/** Reject deeply nested queries before execution (cheap DoS protection). */
export function depthLimit(max: number): ValidationRule {
  return (context) => {
    const depthOf = (node: ASTNode & { selectionSet?: { selections: readonly ASTNode[] } }, d: number): number => {
      if (!node.selectionSet) return d;
      return Math.max(d, ...node.selectionSet.selections.map((s) => depthOf(s as typeof node, d + 1)));
    };
    return {
      OperationDefinition(node) {
        const depth = depthOf(node, 0);
        if (depth > max) context.reportError(new GraphQLError(`query depth ${depth} exceeds limit of ${max}`));
      },
    };
  };
}

/**
 * Per-request tenant transaction. Before this, every resolver and loader batch opened its
 * own transaction (BEGIN, set_config, query, COMMIT), so a dashboard request held up to
 * 7 pooled connections at once and requests queued for the pool under load. One
 * connection per request trades a little intra-request parallelism for far less pool
 * pressure and round trips (see docs/adr/0006). READ ONLY: GraphQL here can't write.
 */
export async function openTenantReadTx(db: Db, clinicId: string): Promise<ControlledTransaction<DB>> {
  const tx = await db.startTransaction().setAccessMode("read only").execute();
  try {
    await sql`SELECT set_config('app.clinic_id', ${clinicId}, true)`.execute(tx);
  } catch (err) {
    await tx.rollback().execute();
    throw err;
  }
  return tx;
}

export async function createGraphqlMiddleware(db: Db, production: boolean): Promise<RequestHandler> {
  const server = new ApolloServer<GqlContext>({
    typeDefs,
    resolvers,
    introspection: !production,
    validationRules: [depthLimit(6)],
    // Apollo's CSRF prevention is on by default: simple (non-preflighted) requests are rejected.
    plugins: [
      {
        // Always release the connection, whether the operation succeeded, failed
        // validation, or threw inside a resolver.
        async requestDidStart() {
          return {
            async willSendResponse({ contextValue }) {
              if (!contextValue.tx.isCommitted && !contextValue.tx.isRolledBack) await contextValue.tx.commit().execute();
            },
          };
        },
      },
    ],
  });
  await server.start();
  return expressMiddleware(server, {
    context: async ({ req }) => {
      const clinicId = principal(req).clinicId;
      const tx = await openTenantReadTx(db, clinicId);
      return { clinicId, tx, loaders: createLoaders(tx) };
    },
  });
}
