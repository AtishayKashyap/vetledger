import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { PageHeader } from "../components/Layout";
import { Badge, Button, Card, Empty, ErrorBanner, Field, Input, Select, Skeleton } from "../components/ui";
import { api, ApiError, newIdempotencyKey } from "../lib/api";
import { ageFrom, fmtDate, fmtDateTime, SPECIES_ICON } from "../lib/format";
import { useUser } from "../lib/session";

interface Animal { id: string; name: string; species: string; breed: string | null; sex: string; birthDate: string | null; weightKg: number | null; tagNumber: string | null; ownerName: string; ownerPhone: string | null; version: number }
interface Visit { id: string; visitedAt: string; reason: string; notes: string | null; weightKg: number | null; vetName: string }
interface Vacc { id: string; product: string; lotNumber: string; administeredAt: string; nextDueOn: string | null; reminderStatus: string | null }
interface Product { id: string; name: string; kind: string; inStock: number }

const REMINDER_TONE = { pending: "neutral", queued: "brand", sent: "ok", failed: "bad" } as const;

function Vaccinate({ animalId }: { animalId: string }) {
  const qc = useQueryClient();
  const products = useQuery({ queryKey: ["products"], queryFn: () => api<{ items: Product[] }>("/products") });
  const vaccines = products.data?.items.filter((p) => p.kind === "vaccine") ?? [];
  const [productId, setProductId] = useState("");
  const [booster, setBooster] = useState("365");
  const [key, setKey] = useState(newIdempotencyKey);
  const m = useMutation({
    mutationFn: () => api<{ nextDueOn: string | null }>("/vaccinations", {
      body: { animalId, productId: productId || vaccines[0]?.id, boosterInDays: booster ? Number(booster) : undefined },
      idempotencyKey: key,
    }),
    onSuccess: () => {
      setKey(newIdempotencyKey()); // next submission is a new operation
      for (const k of [["vaccinations", animalId], ["products"], ["dashboard"]]) void qc.invalidateQueries({ queryKey: k });
    },
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }} className="grid gap-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
      <Field label="Vaccine">
        <Select value={productId} onChange={(e) => setProductId(e.target.value)} aria-label="Vaccine">
          {vaccines.map((v) => <option key={v.id} value={v.id} disabled={v.inStock === 0}>{v.name} ({v.inStock} in stock)</option>)}
        </Select>
      </Field>
      <Field label="Booster in (days)"><Input inputMode="numeric" value={booster} onChange={(e) => setBooster(e.target.value)} /></Field>
      <Button type="submit" disabled={m.isPending || vaccines.length === 0}>{m.isPending ? "Recording…" : "Record vaccination"}</Button>
      {m.isSuccess && <p className="text-sm text-ok sm:col-span-3">Recorded. Lot picked FEFO{m.data.nextDueOn ? `; reminder scheduled for ${fmtDate(m.data.nextDueOn)}` : ""}.</p>}
      <div className="sm:col-span-3"><ErrorBanner error={m.error} /></div>
    </form>
  );
}

function EditWeight({ animal }: { animal: Animal }) {
  const qc = useQueryClient();
  const [weight, setWeight] = useState(String(animal.weightKg ?? ""));
  const m = useMutation({
    // If-Match carries the version this form was rendered from (optimistic concurrency).
    mutationFn: () => api("/animals/" + animal.id, { method: "PATCH", body: { weightKg: Number(weight) }, headers: { "If-Match": `"${animal.version}"` } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["animal", animal.id] }),
  });
  const conflict = m.error instanceof ApiError && m.error.status === 409;
  const submit = (e: FormEvent) => { e.preventDefault(); m.mutate(); };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <Field label="Weight (kg)"><Input className="w-28" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} /></Field>
      <Button variant="secondary" type="submit" disabled={m.isPending}>Update</Button>
      {conflict ? (
        <div role="alert" className="w-full rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn">
          Someone else updated this record. <button type="button" className="underline" onClick={() => { m.reset(); void qc.invalidateQueries({ queryKey: ["animal", animal.id] }); }}>Reload latest</button>
        </div>
      ) : <div className="w-full"><ErrorBanner error={m.error} /></div>}
    </form>
  );
}

export default function AnimalDetail() {
  const { id = "" } = useParams();
  const user = useUser();
  const animal = useQuery({ queryKey: ["animal", id], queryFn: () => api<Animal>(`/animals/${id}`) });
  const visits = useQuery({ queryKey: ["visits", id], queryFn: () => api<{ items: Visit[] }>(`/animals/${id}/visits`) });
  const vaccs = useQuery({ queryKey: ["vaccinations", id], queryFn: () => api<{ items: Vacc[] }>(`/animals/${id}/vaccinations`) });
  const a = animal.data;

  if (animal.error) return <ErrorBanner error={animal.error} />;
  return (
    <>
      <PageHeader
        title={a ? <span><span aria-hidden>{SPECIES_ICON[a.species]} </span>{a.name}</span> : "…"}
        sub={<><Link to="/animals" className="hover:text-brand">Patients</Link>{a && ` / ${a.species}${a.breed ? ` · ${a.breed}` : ""}`}</>}
      />
      <div className="grid gap-5 lg:grid-cols-[1fr_2fr]">
        <Card title="Details">
          {!a ? <Skeleton rows={6} /> : (
            <div className="grid gap-4">
              <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
                <dt className="text-muted">Owner</dt><dd>{a.ownerName}</dd>
                <dt className="text-muted">Phone</dt><dd className="tabular-nums">{a.ownerPhone ?? "—"}</dd>
                <dt className="text-muted">Sex</dt><dd className="capitalize">{a.sex}</dd>
                <dt className="text-muted">Age</dt><dd>{ageFrom(a.birthDate)}{a.birthDate && <span className="text-muted"> (born {fmtDate(a.birthDate)})</span>}</dd>
                <dt className="text-muted">Weight</dt><dd className="tabular-nums">{a.weightKg != null ? `${a.weightKg} kg` : "—"}</dd>
                <dt className="text-muted">Tag</dt><dd className="font-mono text-xs">{a.tagNumber ?? "—"}</dd>
                <dt className="text-muted">Record version</dt><dd className="font-mono text-xs">v{a.version}</dd>
              </dl>
              <EditWeight key={a.version} animal={a} />
            </div>
          )}
        </Card>
        <div className="grid content-start gap-5">
          <Card title="Vaccinations">
            {user.role !== "admin" && <div className="mb-4 border-b border-line pb-4"><Vaccinate animalId={id} /></div>}
            {vaccs.isLoading ? <Skeleton /> : !vaccs.data?.items.length ? <Empty>No vaccinations recorded.</Empty> : (
              <ul className="grid gap-2 text-sm">
                {vaccs.data.items.map((v) => (
                  <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-subtle px-3 py-2">
                    <span><span className="font-medium">{v.product}</span> <span className="font-mono text-xs text-muted">lot {v.lotNumber}</span><span className="block text-xs text-muted">{fmtDateTime(v.administeredAt)}</span></span>
                    {v.nextDueOn && (
                      <span className="text-right text-xs">
                        booster {fmtDate(v.nextDueOn)}{" "}
                        {v.reminderStatus && <Badge tone={REMINDER_TONE[v.reminderStatus as keyof typeof REMINDER_TONE] ?? "neutral"}>reminder {v.reminderStatus}</Badge>}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Visit history">
            {visits.isLoading ? <Skeleton /> : !visits.data?.items.length ? <Empty>No visits yet.</Empty> : (
              <ol className="relative grid gap-4 border-l border-line pl-5">
                {visits.data.items.map((v) => (
                  <li key={v.id} className="relative">
                    <span className="absolute top-1.5 -left-[25px] size-2.5 rounded-full border-2 border-surface bg-brand" aria-hidden />
                    <div className="text-sm font-medium">{v.reason}</div>
                    <div className="text-xs text-muted">{fmtDateTime(v.visitedAt)} · {v.vetName}{v.weightKg ? ` · ${v.weightKg} kg` : ""}</div>
                    {v.notes && <p className="mt-1 text-sm">{v.notes}</p>}
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
