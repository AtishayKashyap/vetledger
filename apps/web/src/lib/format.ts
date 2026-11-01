const DATE = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });
const DATETIME = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const DATETIME_Y = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export const fmtDate = (v: string | null | undefined) => (v ? DATE.format(new Date(v.length === 10 ? `${v}T00:00:00` : v)) : "—");
/** Omits the year for the current year, includes it otherwise ("6 Dec" alone would be ambiguous). */
export function fmtDateTime(v: string | null | undefined, now = new Date()): string {
  if (!v) return "—";
  const d = new Date(v);
  return (d.getFullYear() === now.getFullYear() ? DATETIME : DATETIME_Y).format(d);
}

/** Whole days from today (local) to a YYYY-MM-DD date; negative means overdue. */
export function daysUntil(isoDate: string, now = new Date()): number {
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  return Math.round((Date.UTC(y, m - 1, d) - today) / 86_400_000);
}

export function relativeDays(n: number): string {
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "yesterday";
  return n > 0 ? `in ${n} days` : `${-n} days overdue`;
}

export function ageFrom(birthDate: string | null, now = new Date()): string {
  if (!birthDate) return "—";
  const b = new Date(`${birthDate}T00:00:00`);
  let months = (now.getFullYear() - b.getFullYear()) * 12 + (now.getMonth() - b.getMonth());
  if (now.getDate() < b.getDate()) months -= 1;
  if (months < 12) return `${Math.max(months, 0)} mo`;
  return `${Math.floor(months / 12)} yr`;
}

export const SPECIES_ICON: Record<string, string> = {
  dog: "🐕", cat: "🐈", cattle: "🐄", sheep: "🐑", goat: "🐐", horse: "🐎", poultry: "🐔", other: "🐾",
};
