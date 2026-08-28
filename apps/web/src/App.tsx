import { useState } from "react";
import { getUserId, setUserId } from "./api";
import { cx } from "./ui";
import { Dashboard } from "./views/Dashboard";
import { Accounts } from "./views/Accounts";
import { Budgets } from "./views/Budgets";
import { Banks } from "./views/Banks";

type View = "dashboard" | "accounts" | "budgets" | "banks";

const NAV: Array<{ id: View; label: string; icon: string }> = [
  { id: "dashboard", label: "Dashboard", icon: "◧" },
  { id: "accounts", label: "Accounts", icon: "▤" },
  { id: "budgets", label: "Budgets", icon: "◑" },
  { id: "banks", label: "Banks", icon: "⇄" },
];

export function App() {
  const [view, setView] = useState<View>("dashboard");
  const [user, setUser] = useState(getUserId());

  const changeUser = (id: string) => {
    setUser(id);
    setUserId(id);
    // Reload so every view refetches for the new user.
    window.location.reload();
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
          <label className="field">
            <span className="field-label">Demo user (placeholder auth)</span>
            <input
              value={user}
              onChange={(e) => setUser(e.target.value)}
              onBlur={(e) => changeUser(e.target.value || "demo-user")}
            />
          </label>
        </div>
      </aside>

      <main className="main">
        {view === "dashboard" && <Dashboard />}
        {view === "accounts" && <Accounts />}
        {view === "budgets" && <Budgets />}
        {view === "banks" && <Banks />}
      </main>
    </div>
  );
}
