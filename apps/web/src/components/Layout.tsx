import { NavLink, Outlet } from "react-router-dom";
import { logout } from "../lib/api";
import { useUser } from "../lib/session";

const NAV = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/animals", label: "Patients" },
  { to: "/inventory", label: "Inventory" },
  { to: "/reminders", label: "Reminders" },
  { to: "/audit", label: "Audit log", roles: ["admin"] },
] as const;

export function Layout() {
  const user = useUser();
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:flex-nowrap sm:px-6">
          <div className="flex items-center gap-2 font-semibold">
            <span className="grid size-7 place-items-center rounded-lg bg-brand text-brand-ink" aria-hidden>
              <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="4" strokeLinecap="round"><path d="M12 4v16M4 12h16" /></svg>
            </span>
            <span className="hidden sm:inline">vetledger</span>
          </div>
          <nav className="order-last flex w-full min-w-0 gap-1 overflow-x-auto sm:order-none sm:w-auto sm:flex-1">
            {NAV.filter((n) => !("roles" in n) || (n.roles as readonly string[]).includes(user.role)).map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={"end" in n}
                className={({ isActive }) => `rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap ${isActive ? "bg-subtle font-medium" : "text-muted hover:text-ink"}`}
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm sm:ml-0">
            <div className="hidden text-right md:block">
              <div className="font-medium leading-tight">{user.fullName}</div>
              <div className="text-xs text-muted capitalize">{user.role}</div>
            </div>
            <button className="rounded-md px-2 py-1 text-muted hover:bg-subtle hover:text-ink" onClick={() => void logout()}>Sign out</button>
          </div>
        </div>
      </header>
      <main className="mx-auto grid max-w-6xl gap-5 px-4 py-6 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}

export const PageHeader = ({ title, sub, action }: { title: React.ReactNode; sub?: React.ReactNode; action?: React.ReactNode }) => (
  <div className="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {sub && <div className="mt-0.5 text-sm text-muted">{sub}</div>}
    </div>
    {action}
  </div>
);
