/**
 * First-Expiry-First-Out allocation. Pure function so the business rule is unit-tested
 * in isolation from locking; services/inventory.ts applies it to locked rows.
 */
export interface StockBatch {
  id: string;
  quantity: number;
  expiresOn: string; // YYYY-MM-DD
}
export interface Allocation {
  batchId: string;
  quantity: number;
}

export class InsufficientStockError extends Error {
  constructor(
    readonly requested: number,
    readonly available: number,
  ) {
    super(`insufficient stock: requested ${requested}, available ${available}`);
  }
}

export function allocateFefo(batches: readonly StockBatch[], requested: number, today: string): Allocation[] {
  if (!Number.isInteger(requested) || requested <= 0) throw new RangeError("requested must be a positive integer");
  const usable = batches
    .filter((b) => b.quantity > 0 && b.expiresOn >= today) // never dispense expired stock
    .toSorted((a, b) => a.expiresOn.localeCompare(b.expiresOn) || a.id.localeCompare(b.id));
  const available = usable.reduce((n, b) => n + b.quantity, 0);
  if (available < requested) throw new InsufficientStockError(requested, available);

  const out: Allocation[] = [];
  let remaining = requested;
  for (const b of usable) {
    if (remaining === 0) break;
    const take = Math.min(b.quantity, remaining);
    out.push({ batchId: b.id, quantity: take });
    remaining -= take;
  }
  return out;
}
