import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Card, Skeleton } from "./components/ui";
import { useSession } from "./lib/session";
import { Dashboard } from "./pages/Dashboard";
import { Login } from "./pages/Login";

const Animals = lazy(() => import("./pages/Animals"));
const AnimalDetail = lazy(() => import("./pages/AnimalDetail"));
const Inventory = lazy(() => import("./pages/Inventory"));
const Reminders = lazy(() => import("./pages/Reminders"));
const Audit = lazy(() => import("./pages/Audit"));

function Protected() {
  const s = useSession();
  const loc = useLocation();
  if (s.status === "loading") return <div className="grid min-h-screen place-items-center text-muted">Loading…</div>;
  if (s.status === "anonymous") return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <Layout />;
}

export function App() {
  return (
    <Suspense fallback={<Card><Skeleton rows={4} /></Card>}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<Protected />}>
          <Route index element={<Dashboard />} />
          <Route path="animals" element={<Animals />} />
          <Route path="animals/:id" element={<AnimalDetail />} />
          <Route path="inventory" element={<Inventory />} />
          <Route path="reminders" element={<Reminders />} />
          <Route path="audit" element={<Audit />} />
          <Route path="*" element={<Card>Page not found.</Card>} />
        </Route>
      </Routes>
    </Suspense>
  );
}
