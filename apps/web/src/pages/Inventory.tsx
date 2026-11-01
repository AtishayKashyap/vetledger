import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { PageHeader } from "../components/Layout";
import { Badge, Button, Card, Empty, ErrorBanner, Field, Input, Skeleton, Table } from "../components/ui";
import { api, newIdempotencyKey } from "../lib/api";
import { daysUntil, fmtDate, fmtDateTime } from "../lib/format";
import { useUser } from "../lib/session";

interface Product { id: string; sku: string; name: string; kind: string; unit: string; reorderLevel: number; inStock: number; expired: number; nextExpiry: string | null }
interface Batch { id: string; lotNumber: string; expiresOn: string; quantity: number; receivedAt: string }
interface Recipient { animalId: string; animalName: string; ownerName: string; ownerPhone: string | null; quantity: number; at: string }

function Recall({ batch, onClose }: { batch: Batch; onClose: () => void }) {
  const q = useQuery({ queryKey: ["recall", batch.id], queryFn: () => api<{ items: Recipient[] }>(`/batches/${batch.id}/recipients`) });
  return (
    <div className="mt-3 rounded-lg border border-warn/40 bg-warn-bg/50 p-3 text-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium">Recall trace · lot <span className="font-mono">{batch.lotNumber}</span></span>
        <button className="text-muted hover:text-ink" onClick={onClose}>Close</button>
      </div>
      {q.isLoading ? <Skeleton /> : !q.data?.items.length ? <p className="text-muted">No animals received doses from this lot.</p> : (
        <ul className="grid gap-1">
          {q.data.items.map((r, i) => (
            <li key={i} className="flex justify-between gap-2"><span>{r.animalName} <span className="text-muted">· {r.ownerName} {r.ownerPhone}</span></span><span className="text-muted tabular-nums">{r.quantity} · {fmtDateTime(r.at)}</span></li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Batches({ product }: { product: Product }) {
  const user = useUser();
  const qc = useQueryClient();
  const [recall, setRecall] = useState<Batch | null>(null);
  const q = useQuery({ queryKey: ["batches", product.id], queryFn: () => api<{ items: Batch[] }>(`/products/${product.id}/batches`) });
  const [form, setForm] = useState({ lotNumber: "", expiresOn: "", quantity: "" });
  const [key, setKey] = useState(newIdempotencyKey);
  const receive = useMutation({
    mutationFn: () => api("/batches", { body: { productId: product.id, ...form, quantity: Number(form.quantity) }, idempotencyKey: key }),
    onSuccess: () => {
      setForm({ lotNumber: "", expiresOn: "", quantity: "" });
      setKey(newIdempotencyKey());
      void qc.invalidateQueries({ queryKey: ["batches", product.id] });
      void qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); receive.mutate(); };
  // The batch FEFO will draw from next: earliest unexpired with stock.
  const next = q.data?.items.find((b) => b.quantity > 0 && daysUntil(b.expiresOn) >= 0);
  return (
    <div className="bg-subtle/60 px-5 py-4">
      {q.isLoading ? <Skeleton /> : (
        <ul className="grid gap-1.5 text-sm">
          {q.data?.items.map((b) => {
            const d = daysUntil(b.expiresOn);
            return (
              <li key={b.id} className="flex flex-wrap items-center gap-3">
                <span className="w-24 font-mono text-xs">{b.lotNumber}</span>
                <span className="w-32 whitespace-nowrap text-muted">exp {fmtDate(b.expiresOn)}</span>
                <span className="w-24 whitespace-nowrap tabular-nums">{b.quantity} {product.unit}</span>
                {d < 0 ? <Badge tone="bad">expired · quarantined</Badge> : b.id === next?.id ? <Badge tone="brand">next out (FEFO)</Badge> : d <= 30 ? <Badge tone="warn">{d}d left</Badge> : null}
                <button className="ml-auto text-xs text-muted hover:text-ink" onClick={() => setRecall(b)}>Recall trace</button>
              </li>
            );
          })}
        </ul>
      )}
      {recall && <Recall batch={recall} onClose={() => setRecall(null)} />}
      {user.role === "admin" && (
        <form onSubmit={submit} className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-4 sm:items-end">
          <Field label="Lot number"><Input value={form.lotNumber} onChange={(e) => setForm({ ...form, lotNumber: e.target.value })} required /></Field>
          <Field label="Expires on"><Input type="date" value={form.expiresOn} onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} required /></Field>
          <Field label={`Quantity (${product.unit})`}><Input inputMode="numeric" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} required /></Field>
          <Button type="submit" variant="secondary" disabled={receive.isPending}>Receive stock</Button>
          <div className="sm:col-span-4"><ErrorBanner error={receive.error} /></div>
        </form>
      )}
    </div>
  );
}

export default function Inventory() {
  const q = useQuery({ queryKey: ["products"], queryFn: () => api<{ items: Product[] }>("/products") });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Inventory" sub="Stock is tracked per lot and dispensed first-expiry-first-out." />
      <Card>
        <ErrorBanner error={q.error} />
        {q.isLoading ? <Skeleton rows={6} /> : !q.data?.items.length ? <Empty>No products yet.</Empty> : (
          <Table head={["Product", "SKU", "Type", "In stock", "Next expiry", "Status", ""]}>
            {q.data.items.map((p) => {
              const low = p.inStock <= p.reorderLevel;
              return [
                <tr key={p.id} className="hover:bg-subtle">
                  <td className="px-5 py-2.5 font-medium">{p.name}</td>
                  <td className="px-5 py-2.5 font-mono text-xs">{p.sku}</td>
                  <td className="px-5 py-2.5 capitalize">{p.kind}</td>
                  <td className="px-5 py-2.5 tabular-nums">{p.inStock} <span className="text-muted">{p.unit}</span></td>
                  <td className="px-5 py-2.5 whitespace-nowrap">{fmtDate(p.nextExpiry)}</td>
                  <td className="px-5 py-2.5"><span className="flex gap-1">{low ? <Badge tone="bad">reorder</Badge> : <Badge tone="ok">ok</Badge>}{p.expired > 0 && <Badge tone="warn">{p.expired} expired</Badge>}</span></td>
                  <td className="px-5 py-2.5 text-right"><button className="text-sm text-brand" aria-expanded={open === p.id} onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? "Hide lots" : "Lots"}</button></td>
                </tr>,
                open === p.id && <tr key={`${p.id}-b`}><td colSpan={7} className="p-0"><Batches product={p} /></td></tr>,
              ];
            })}
          </Table>
        )}
      </Card>
    </>
  );
}
