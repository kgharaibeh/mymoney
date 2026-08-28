import { useState } from "react";
import { api } from "../api";
import { Banner, Empty, MoneyText, Section, useAsync } from "../ui";

const BASES = ["USD", "EUR", "GBP", "JPY", "AED", "SAR", "JOD"];

export function Dashboard() {
  const [base, setBase] = useState("USD");
  const accounts = useAsync(() => api.listAccounts(), []);
  const nw = useAsync(() => api.netWorth(base), [base]);

  return (
    <>
      <div className="page-head">
        <h1>Dashboard</h1>
        <p>Your whole financial picture, converted to one currency.</p>
      </div>

      <Section
        title="Net worth"
        actions={
          <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <span className="field-label">Base</span>
            <select value={base} onChange={(e) => setBase(e.target.value)}>
              {BASES.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
          </label>
        }
      >
        {nw.error && <Banner kind="error">{nw.error}</Banner>}
        <div className="stat">
          <span className="label">Total net worth · {base}</span>
          <span className="value">
            {nw.loading ? "…" : nw.data ? <MoneyText value={nw.data.netWorth} strong /> : "—"}
          </span>
        </div>
      </Section>

      <Section title="Accounts" actions={<button className="btn" onClick={() => accounts.reload()}>Refresh</button>}>
        {accounts.error && <Banner kind="error">{accounts.error}</Banner>}
        {accounts.data && accounts.data.length === 0 && (
          <Empty>No accounts yet — add one under Accounts, or link a bank under Banks.</Empty>
        )}
        {accounts.data && accounts.data.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Type</th>
                  <th>Currency</th>
                  <th className="num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {accounts.data.map((a) => (
                  <tr key={a.id}>
                    <td>{a.name}</td>
                    <td>{a.type.replace("_", " ")}</td>
                    <td className="mono">{a.currency}</td>
                    <td className="num">{a.balance ? <MoneyText value={a.balance} /> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}
