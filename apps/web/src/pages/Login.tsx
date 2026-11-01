import { useState, type FormEvent } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Button, ErrorBanner, Field, Input } from "../components/ui";
import { login } from "../lib/api";
import { useSession } from "../lib/session";

const DEMO = [
  { email: "admin@sunrise.vet", role: "Admin" },
  { email: "vet@sunrise.vet", role: "Vet" },
  { email: "tech@sunrise.vet", role: "Technician" },
  { email: "vet@deccan.vet", role: "Vet (2nd clinic)" },
];

export function Login() {
  const session = useSession();
  const loc = useLocation();
  const [email, setEmail] = useState("vet@sunrise.vet");
  const [password, setPassword] = useState("vetledger-demo");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (session.status === "authenticated") return <Navigate to={(loc.state as { from?: string } | null)?.from ?? "/"} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2 text-lg font-semibold">
          <span className="grid size-8 place-items-center rounded-lg bg-brand text-brand-ink" aria-hidden>
            <svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="4" strokeLinecap="round"><path d="M12 4v16M4 12h16" /></svg>
          </span>
          vetledger
        </div>
        <form onSubmit={submit} className="grid gap-4 rounded-xl border border-line bg-surface p-6 shadow-sm">
          <div>
            <h1 className="text-lg font-semibold">Sign in</h1>
            <p className="text-sm text-muted">Clinic records, stock and vaccination reminders.</p>
          </div>
          <ErrorBanner error={error} />
          <Field label="Email">
            <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Field>
          <Field label="Password">
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <Button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
        </form>
        <div className="mt-4 rounded-xl border border-dashed border-line p-4 text-xs text-muted">
          <div className="mb-2 font-medium text-ink">Demo accounts · password <code className="font-mono">vetledger-demo</code></div>
          <div className="grid gap-1">
            {DEMO.map((d) => (
              <button key={d.email} type="button" className="flex justify-between rounded px-1 py-0.5 text-left hover:bg-subtle" onClick={() => setEmail(d.email)}>
                <span className="font-mono">{d.email}</span><span>{d.role}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
