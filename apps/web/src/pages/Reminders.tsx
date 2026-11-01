import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "../components/Layout";
import { Badge, Button, Card, Empty, ErrorBanner, Skeleton, Stat, Table } from "../components/ui";
import { api } from "../lib/api";
import { daysUntil, fmtDate, fmtDateTime, relativeDays } from "../lib/format";
import { useUser } from "../lib/session";

interface Reminder { id: string; dueOn: string; status: "pending" | "queued" | "sent" | "failed"; attempts: number; lastError: string | null; sentAt: string | null; animalId: string; animalName: string; ownerName: string }
interface Resp { items: Reminder[]; queue: Record<string, number> }
const TONE = { pending: "neutral", queued: "brand", sent: "ok", failed: "bad" } as const;
const FILTERS = ["all", "pending", "queued", "sent", "failed"] as const;

export default function Reminders() {
  const user = useUser();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const q = useQuery({ queryKey: ["reminders", filter], queryFn: () => api<Resp>(`/reminders${filter === "all" ? "" : `?status=${filter}`}`), refetchInterval: 10_000 });
  const retry = useMutation({
    mutationFn: (id: string) => api(`/reminders/${id}/retry`, { method: "POST" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["reminders"] }),
  });
  const queue = q.data?.queue;
  return (
    <>
      <PageHeader title="Vaccination reminders" sub="Claimed by the scheduler when due, delivered by a background worker with retries." />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Queue · waiting" value={queue?.waiting ?? "…"} />
        <Stat label="Queue · retrying" value={queue?.delayed ?? "…"} />
        <Stat label="Delivered" value={queue?.completed ?? "…"} tone="ok" />
        <Stat label="Dead-lettered" value={queue?.failed ?? "…"} tone={queue?.failed ? "bad" : undefined} />
      </div>
      <Card title={
        <div className="flex flex-wrap gap-1" role="tablist">
          {FILTERS.map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)} className={`rounded-md px-2.5 py-1 text-sm capitalize ${filter === f ? "bg-subtle font-medium" : "text-muted hover:text-ink"}`}>{f}</button>
          ))}
        </div>
      }>
        <ErrorBanner error={q.error ?? retry.error} />
        {q.isLoading ? <Skeleton rows={6} /> : !q.data?.items.length ? <Empty>No reminders.</Empty> : (
          <Table head={["Patient", "Owner", "Due", "Status", "Attempts", ""]}>
            {q.data.items.map((r) => (
              <tr key={r.id}>
                <td className="px-5 py-2.5"><Link className="font-medium hover:text-brand" to={`/animals/${r.animalId}`}>{r.animalName}</Link></td>
                <td className="px-5 py-2.5">{r.ownerName}</td>
                <td className="px-5 py-2.5 whitespace-nowrap">{fmtDate(r.dueOn)} <span className="text-xs text-muted">{relativeDays(daysUntil(r.dueOn))}</span></td>
                <td className="px-5 py-2.5"><Badge tone={TONE[r.status]}>{r.status}</Badge>{r.sentAt && <span className="ml-2 text-xs text-muted">{fmtDateTime(r.sentAt)}</span>}{r.lastError && <span className="ml-2 text-xs text-bad">{r.lastError}</span>}</td>
                <td className="px-5 py-2.5 tabular-nums">{r.attempts}</td>
                <td className="px-5 py-2.5 text-right">{r.status === "failed" && user.role === "admin" && <Button variant="secondary" onClick={() => retry.mutate(r.id)} disabled={retry.isPending}>Retry</Button>}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
