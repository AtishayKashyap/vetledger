import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { onSessionChange, refreshSession, type SessionUser } from "./api";

type State = { status: "loading" } | { status: "anonymous" } | { status: "authenticated"; user: SessionUser };
const Ctx = createContext<State>({ status: "loading" });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading" });
  useEffect(() => {
    const off = onSessionChange((u) => setState(u ? { status: "authenticated", user: u } : { status: "anonymous" }));
    // Restore the session from the refresh cookie on page load.
    void refreshSession();
    return off;
  }, []);
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export const useSession = () => useContext(Ctx);

export function useUser(): SessionUser {
  const s = useSession();
  if (s.status !== "authenticated") throw new Error("useUser outside an authenticated route");
  return s.user;
}
