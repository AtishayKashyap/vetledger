import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { ApiError } from "../lib/api";

export function Card({ title, action, children, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-xl border border-line bg-surface p-5 shadow-sm ${className}`}>
      {(title || action) && (
        <header className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-[15px] font-semibold">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

type Variant = "primary" | "secondary" | "ghost";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand text-brand-ink hover:opacity-90",
  secondary: "border border-line bg-surface hover:bg-subtle",
  ghost: "hover:bg-subtle text-muted hover:text-ink",
};
export function Button({ variant = "primary", className = "", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...p}
      className={`inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
    />
  );
}

export function Field({ label, error, children, hint }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {error ? <span className="text-xs text-bad">{error}</span> : hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

const control = "h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm placeholder:text-muted";
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={`${control} ${p.className ?? ""}`} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={`${control} ${p.className ?? ""}`} />;

type Tone = "ok" | "warn" | "bad" | "neutral" | "brand";
const TONES: Record<Tone, string> = {
  ok: "bg-ok-bg text-ok",
  warn: "bg-warn-bg text-warn",
  bad: "bg-bad-bg text-bad",
  neutral: "bg-subtle text-muted",
  brand: "bg-subtle text-brand",
};
export const Badge = ({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) => (
  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${TONES[tone]}`}>{children}</span>
);

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "bad" | "ok" }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
      <div className="text-xs font-medium tracking-wide text-muted uppercase">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone === "bad" ? "text-bad" : tone === "ok" ? "text-ok" : ""}`}>{value}</div>
    </div>
  );
}

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof ApiError ? error.problem.detail ?? error.problem.title : error instanceof Error ? error.message : String(error);
  const fields = error instanceof ApiError ? error.problem.errors : undefined;
  return (
    <div role="alert" className="rounded-lg border border-bad/30 bg-bad-bg px-3 py-2 text-sm text-bad">
      {msg}
      {fields && (
        <ul className="mt-1 list-disc pl-5">
          {fields.map((f) => <li key={f.path}>{f.path}: {f.message}</li>)}
        </ul>
      )}
    </div>
  );
}

export const Skeleton = ({ rows = 3 }: { rows?: number }) => (
  <div className="grid gap-2" aria-busy="true" aria-label="Loading">
    {Array.from({ length: rows }, (_, i) => (
      <div key={i} className="h-4 animate-pulse rounded bg-subtle motion-reduce:animate-none" style={{ width: `${92 - i * 11}%` }} />
    ))}
  </div>
);

export const Empty = ({ children }: { children: ReactNode }) => <div className="py-10 text-center text-sm text-muted">{children}</div>;

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="-mx-5 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            {head.map((h, i) => <th key={i} className="px-5 py-2 font-medium whitespace-nowrap">{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}
