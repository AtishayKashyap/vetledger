import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { animalCreateSchema, SPECIES } from "@vetledger/shared";
import { useDeferredValue, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PageHeader } from "../components/Layout";
import { Button, Card, Empty, ErrorBanner, Field, Input, Select, Skeleton, Table } from "../components/ui";
import { api, newIdempotencyKey } from "../lib/api";
import { ageFrom, SPECIES_ICON } from "../lib/format";

interface Animal { id: string; name: string; species: string; breed: string | null; birthDate: string | null; weightKg: number | null; ownerName: string; tagNumber: string | null }
interface Page { items: Animal[]; nextCursor: string | null }
interface Owner { id: string; fullName: string }

function NewAnimal({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const owners = useQuery({ queryKey: ["owners"], queryFn: () => api<{ items: Owner[] }>("/owners?limit=100") });
  const [form, setForm] = useState({ ownerId: "", name: "", species: "dog", breed: "", weightKg: "" });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // One key per form instance: a double-submit or retried request creates one animal.
  const [key] = useState(newIdempotencyKey);
  const m = useMutation({
    mutationFn: (body: unknown) => api<{ id: string }>("/animals", { body, idempotencyKey: key }),
    onSuccess: (a) => {
      void qc.invalidateQueries({ queryKey: ["animals"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      nav(`/animals/${a.id}`);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    // Same Zod schema the server uses: instant feedback, no drift.
    const parsed = animalCreateSchema.safeParse({
      ownerId: form.ownerId, name: form.name, species: form.species,
      breed: form.breed || undefined, weightKg: form.weightKg ? Number(form.weightKg) : undefined,
    });
    if (!parsed.success) {
      setFieldErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
      return;
    }
    setFieldErrors({});
    m.mutate(parsed.data);
  };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <Card title="Register a patient" action={<Button variant="ghost" onClick={onDone}>Cancel</Button>}>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="Owner" error={fieldErrors.ownerId && "choose an owner"}>
          <Select value={form.ownerId} onChange={set("ownerId")} aria-label="Owner">
            <option value="">Select…</option>
            {owners.data?.items.map((o) => <option key={o.id} value={o.id}>{o.fullName}</option>)}
          </Select>
        </Field>
        <Field label="Name" error={fieldErrors.name}><Input value={form.name} onChange={set("name")} /></Field>
        <Field label="Species">
          <Select value={form.species} onChange={set("species")}>{SPECIES.map((s) => <option key={s}>{s}</option>)}</Select>
        </Field>
        <Field label="Breed"><Input value={form.breed} onChange={set("breed")} /></Field>
        <Field label="Weight (kg)" error={fieldErrors.weightKg}><Input inputMode="decimal" value={form.weightKg} onChange={set("weightKg")} /></Field>
        <div className="flex items-center gap-3 sm:col-span-2 lg:col-span-5">
          <Button type="submit" disabled={m.isPending}>{m.isPending ? "Saving…" : "Register"}</Button>
          <ErrorBanner error={m.error} />
        </div>
      </form>
    </Card>
  );
}

export default function Animals() {
  const [search, setSearch] = useState("");
  const q = useDeferredValue(search.trim());
  const [adding, setAdding] = useState(false);
  const list = useInfiniteQuery({
    queryKey: ["animals", q],
    queryFn: ({ pageParam }) => api<Page>(`/animals?limit=20${q ? `&q=${encodeURIComponent(q)}` : ""}${pageParam ? `&cursor=${pageParam}` : ""}`),
    initialPageParam: "",
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader title="Patients" sub="Every animal registered at your clinic." action={!adding && <Button onClick={() => setAdding(true)}>+ New patient</Button>} />
      {adding && <NewAnimal onDone={() => setAdding(false)} />}
      <Card title={<Input type="search" placeholder="Search by name…" value={search} onChange={(e) => setSearch(e.target.value)} className="w-64 max-w-full font-normal" aria-label="Search patients" />}>
        <ErrorBanner error={list.error} />
        {list.isLoading ? <Skeleton rows={6} /> : rows.length === 0 ? <Empty>No patients match “{q}”.</Empty> : (
          <Table head={["Patient", "Species", "Owner", "Age", "Weight", "Tag"]}>
            {rows.map((a) => (
              <tr key={a.id} className="hover:bg-subtle">
                <td className="px-5 py-2.5"><Link to={`/animals/${a.id}`} className="font-medium hover:text-brand">{a.name}</Link></td>
                <td className="px-5 py-2.5 whitespace-nowrap"><span aria-hidden>{SPECIES_ICON[a.species]} </span>{a.species}{a.breed && <span className="text-muted"> · {a.breed}</span>}</td>
                <td className="px-5 py-2.5">{a.ownerName}</td>
                <td className="px-5 py-2.5 tabular-nums">{ageFrom(a.birthDate)}</td>
                <td className="px-5 py-2.5 tabular-nums">{a.weightKg != null ? `${a.weightKg} kg` : "—"}</td>
                <td className="px-5 py-2.5 font-mono text-xs text-muted">{a.tagNumber ?? "—"}</td>
              </tr>
            ))}
          </Table>
        )}
        {list.hasNextPage && (
          <div className="mt-4 text-center">
            <Button variant="secondary" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
              {list.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
