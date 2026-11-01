import { sql } from "kysely";
import type { Tx } from "../db.js";
import { AppError } from "../http/errors.js";
import { allocateFefo, InsufficientStockError, type Allocation } from "./fefo.js";

export const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);

/**
 * Lock this product's usable batches and decrement them FEFO, inside the caller's
 * transaction.
 *
 * Locking: `FOR UPDATE` in a deterministic order (expires_on, id). Concurrent
 * dispenses of the same product therefore queue on the same first row instead of
 * deadlocking, and each re-reads the committed quantity after acquiring the lock.
 * `SKIP LOCKED` would be WRONG here: a transaction would skip a locked batch and wrongly
 * report "insufficient stock" while that stock is still available.
 */
export async function dispenseFefo(tx: Tx, productId: string, quantity: number, today = todayUtc()): Promise<Allocation[]> {
  const rows = await tx
    .selectFrom("batches")
    .select(["id", "quantity", "expires_on"])
    .where("product_id", "=", productId)
    .where("quantity", ">", 0)
    .where("expires_on", ">=", today)
    .orderBy("expires_on")
    .orderBy("id")
    .forUpdate()
    .execute();

  let allocations: Allocation[];
  try {
    allocations = allocateFefo(
      rows.map((r) => ({ id: r.id, quantity: r.quantity, expiresOn: r.expires_on })),
      quantity,
      today,
    );
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      throw new AppError(409, "Insufficient Stock", err.message, { available: err.available, requested: err.requested });
    }
    throw err;
  }
  for (const a of allocations) {
    await tx
      .updateTable("batches")
      .set({ quantity: sql`quantity - ${a.quantity}` })
      .where("id", "=", a.batchId)
      .execute();
  }
  return allocations;
}
