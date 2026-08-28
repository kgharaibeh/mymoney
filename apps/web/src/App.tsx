import { useEffect, useState } from "react";
import { api, clearSession, getToken } from "./api";
import { cx, Spinner, Toaster } from "./ui";
import { Auth } from "./views/Auth";
import { Dashboard } from "./views/Dashboard";
import { Accounts } from "./views/Accounts";
import { Budgets } from "./views/Budgets";
import { Banks } from "./views/Banks";
import { Settings } from "./views/Settings";

type View = "dashboard" | "accounts" | "budgets" | "banks" | "settings";

const NAV: Array<{ id: View; label: string; icon: string }> = [
  { id: "dashboard", label: "Dashboard", icon: "◧" },
  { id: "accounts", label: "Accounts", icon: "▤" },
  { id: "budgets", label: "Budgets", icon: "◑" },
  { id: "banks", label: "Banks", icon: "⇄" },
  { id: "settings", label: "Settings", icon: "⚙" },
];

export function App() {
  const [email, setEmail] = useState<string | null>(null);
  const [checking, setChecking] = useState<boolean>(!!getToken());
  const [view, setView] = useState<View>("dashboard");

  // Validate any stored token on load — a stale/revoked one drops us to login.
  useEffect(() => {
    if (!getToken()) return;
    api
      .me()
      .then((u) => setEmail(u.email))
      .catch(() => clearSession())
      .finally(() => setChecking(false));
  }, []);

  if (checking) {
    return (
      <>
        <div className="auth-shell">
          <Spinner label="Loading MyMoney…" />
        </div>
        <Toaster />
      </>
    );
  }

  if (!email) {
    return (
      <>
        <Auth onAuthed={(e) => setEmail(e)} />
        <Toaster />
      </>
    );
  }

  const logout = () => {
    clearSession();
    setEmail(null);
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo">MyMoney</span>
          <span className="tag">v0.1</span>
        </div>
        {NAV.map((n) => (
          <button key={n.id} className={cx("nav-item", view === n.id && "active")} onClick={() => setView(n.id)}>
            <span className="ic" aria-hidden>
              {n.icon}
            </span>
            {n.label}
          </button>
        ))}
        <div className="sidebar-foot">
          <div className="field-label">Signed in as</div>
          <div style={{ fontSize: "0.9rem", margin: "2px 0 10px", wordBreak: "break-all" }}>{email}</div>
          <button className="btn btn-ghost" style={{ padding: "6px 10px" }} onClick={logout}>
            Log out
          </button>
        </div>
      </aside>

      <main className="main">
        {view === "dashboard" && <Dashboard />}
        {view === "accounts" && <Accounts />}
        {view === "budgets" && <Budgets />}
        {view === "banks" && <Banks />}
        {view === "settings" && <Settings />}
      </main>
      <Toaster />
    </div>
  );
}
