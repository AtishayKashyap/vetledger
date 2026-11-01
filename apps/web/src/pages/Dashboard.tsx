import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { PageHeader } from "../components/Layout";
import { Badge, Card, Empty, ErrorBanner, Skeleton, Stat } from "../components/ui";
import { gql } from "../lib/api";
import { daysUntil, fmtDate, relativeDays, SPECIES_ICON } from "../lib/format";
import { useUser } from "../lib/session";

interface DashboardData {
  dashboard: {
    stats: { animals: number; owners: number; visitsLast30d: number; vaccinationsLast30d: number; pendingReminders: number; failedReminders: number };
    upcomingVaccinations: { reminderId: string; dueOn: string; status: string; animal: { id: string; name: string; species: string; owner: { fullName: string; phone: string | null } } }[];
    lowStock: { productId: string; sku: string; name: string; inStock: number; reorderLevel: number }[];
    expiringBatches: { batchId: string; product: string; lotNumber: string; expiresOn: string; quantity: number; daysLeft: number }[];
  };
}

// One GraphQL round trip for the whole dashboard.
export const DASHBOARD_QUERY = /* GraphQL */ `{
  dashboard {
    stats { animals owners visitsLast30d vaccinationsLast30d pendingReminders failedReminders }
    upcomingVaccinations(days: 14) { reminderId dueOn status animal { id name species owner { fullName phone } } }
    lowStock { productId sku name inStock reorderLevel }
    expiringBatches(days: 45) { batchId product lotNumber expiresOn quantity daysLeft }
  }
}`;

export function Dashboard() {
  const user = useUser();
  const q = useQuery({ queryKey: ["dashboard"], queryFn: () => gql<DashboardData>(DASHBOARD_QUERY), refetchInterval: 60_000 });
  const d = q.data?.dashboard;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <>
      <PageHeader title={`${greeting}, ${user.fullName.split(" ").slice(0, 2).join(" ")}`} sub="Here's what needs attention at your clinic." />
      <ErrorBanner error={q.error} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Patients" value={d?.stats.animals ?? "…"} />
        <Stat label="Visits · 30 days" value={d?.stats.visitsLast30d ?? "…"} />
        <Stat label="Reminders pending" value={d?.stats.pendingReminders ?? "…"} />
        <Stat label="Failed reminders" value={d?.stats.failedReminders ?? "…"} tone={d ? (d.stats.failedReminders ? "bad" : "ok") : undefined} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
        <Card title="Vaccinations due · next 14 days" action={<Link className="text-sm text-brand" to="/reminders">All reminders →</Link>}>
          {!d ? <Skeleton rows={5} /> : d.upcomingVaccinations.length === 0 ? <Empty>Nothing due in the next two weeks.</Empty> : (
            <ul className="-mx-2 divide-y divide-line">
              {d.upcomingVaccinations.slice(0, 8).map((v) => {
                const days = daysUntil(v.dueOn);
                return (
                  <li key={v.reminderId}>
                    <Link to={`/animals/${v.animal.id}`} className="flex items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-subtle">
                      <span className="text-xl" aria-hidden>{SPECIES_ICON[v.animal.species] ?? "🐾"}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{v.animal.name}</span>
                        <span className="block truncate text-xs text-muted">{v.animal.owner.fullName} · {v.animal.owner.phone ?? "no phone"}</span>
                      </span>
                      <span className="text-right">
                        <Badge tone={v.status === "failed" ? "bad" : days < 0 ? "warn" : days <= 3 ? "brand" : "neutral"}>
                          {v.status === "failed" ? "delivery failed" : relativeDays(days)}
                        </Badge>
                        <span className="mt-0.5 block text-xs text-muted">{fmtDate(v.dueOn)}</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <div className="grid content-start gap-5">
          <Card title="Low stock" action={<Link className="text-sm text-brand" to="/inventory">Inventory →</Link>}>
            {!d ? <Skeleton /> : d.lowStock.length === 0 ? <Empty>All products above reorder level.</Empty> : (
              <ul className="grid gap-3">
                {d.lowStock.map((p) => (
                  <li key={p.productId}>
                    <div className="flex justify-between text-sm"><span className="font-medium">{p.name}</span><span className="tabular-nums text-bad">{p.inStock} / {p.reorderLevel}</span></div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-subtle">
                      <div className="h-full rounded-full bg-bad" style={{ width: `${Math.min(100, (p.inStock / Math.max(p.reorderLevel, 1)) * 100)}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Expiring soon">
            {!d ? <Skeleton /> : d.expiringBatches.length === 0 ? <Empty>No batches expire in the next 45 days.</Empty> : (
              <ul className="grid gap-2 text-sm">
                {d.expiringBatches.slice(0, 6).map((b) => (
                  <li key={b.batchId} className="flex items-center justify-between gap-2">
                    <span className="min-w-0"><span className="block truncate">{b.product}</span><span className="font-mono text-xs text-muted">lot {b.lotNumber} · {b.quantity} left</span></span>
                    <Badge tone={b.daysLeft <= 14 ? "bad" : "warn"}>{b.daysLeft}d</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
