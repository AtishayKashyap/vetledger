import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "../components/Layout";
import { Badge, Card, ErrorBanner, Skeleton, Table } from "../components/ui";
import { api } from "../lib/api";
import { fmtDateTime } from "../lib/format";

interface Entry { id: number; at: string; action: string; entity: string; entityId: string | null; data: Record<string, unknown>; requestId: string | null; actor: string | null }

export default function Audit() {
  const q = useQuery({ queryKey: ["audit"], queryFn: () => api<{ items: Entry[] }>("/audit?limit=200") });
  return (
    <>
      <PageHeader title="Audit log" sub="Append-only: updates and deletes are rejected by the database itself." />
      <Card>
        <ErrorBanner error={q.error} />
        {q.isLoading ? <Skeleton rows={8} /> : (
          <Table head={["When", "Who", "Action", "Entity", "Details", "Request"]}>
            {q.data?.items.map((e) => (
              <tr key={e.id}>
                <td className="px-5 py-2 whitespace-nowrap text-muted">{fmtDateTime(e.at)}</td>
                <td className="px-5 py-2 whitespace-nowrap">{e.actor ?? "system"}</td>
                <td className="px-5 py-2"><Badge tone={e.action === "login" ? "neutral" : "brand"}>{e.action}</Badge></td>
                <td className="px-5 py-2">{e.entity}</td>
                <td className="max-w-xs truncate px-5 py-2 font-mono text-xs text-muted" title={JSON.stringify(e.data)}>{Object.keys(e.data).length ? JSON.stringify(e.data) : ""}</td>
                <td className="px-5 py-2 font-mono text-xs text-muted">{e.requestId?.slice(0, 8)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
