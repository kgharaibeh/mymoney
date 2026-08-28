import { useState } from "react";
import { api } from "../api";
import { currentPeriod } from "../format";
import { Banner, Button, Empty, Field, MoneyText, Section, cx, useAsync } from "../ui";

const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "AED", "SAR", "JOD"];

export function Budgets() {
  const [period, setPeriod] = useState(currentPeriod());
  const budgets = useAsync(() => api.listBudgets(period), [period]);

  return (
    <>
      <div className="page-head">
        <h1>Budgets</h1>
        <p>Set monthly limits per category and track spending against them.</p>
      </div>

      <CreateBudget defaultPeriod={period} onCreated={() => budgets.reload()} />

      <Section
        title="Budget vs. actual"
        actions={
          <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <span className="field-label">Period</span>
            <input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="YYYY-MM" style={{ width: 110 }} />
          </label>
        }
      >
        {budgets.error && <Banner kind="error">{budgets.error}</Banner>}
        {budgets.data && budgets.data.length === 0 && <Empty>No budgets for {period}.</Empty>}
        {budgets.data && budgets.data.length > 0 && (
          <div style={{ display: "grid", gap: 16 }}>
            {budgets.data.map((b) => {
              const limit = Number(b.limit.decimal) || 0;
              const spent = Number(b.spent.decimal) || 0;
              const pct = limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : 0;
              const over = spent > limit;
              return (
                <div key={b.id}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <strong>{b.categoryId}</strong>
                    <span>
                      <MoneyText value={b.spent} /> <span style={{ color: "var(--muted)" }}>/ {b.limit.decimal}</span>
                    </span>
                  </div>
                  <div className={cx("bar", over && "over")}>
                    <span style={{ width: `${over ? 100 : pct}%` }} />
                  </div>
                  <div style={{ marginTop: 4, fontSize: "0.82rem", color: over ? "var(--neg)" : "var(--muted)" }}>
                    {over ? "Over budget by " : "Remaining "}
                    <MoneyText value={b.remaining} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </>
  );
}

function CreateBudget({ defaultPeriod, onCreated }: { defaultPeriod: string; onCreated: () => void }) {
  const [categoryId, setCategoryId] = useState("");
  const [period, setPeriod] = useState(defaultPeriod);
  const [limit, setLimit] = useState("500.00");
  const [currency, setCurrency] = useState("USD");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.createBudget({ categoryId, period, limit, currency });
      setCategoryId("");
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Set a budget">
      {error && <Banner kind="error">{error}</Banner>}
      <div className="form-row">
        <Field label="Category">
          <input value={categoryId} onChange={(e) => setCategoryId(e.target.value)} placeholder="food" />
        </Field>
        <Field label="Period">
          <input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="YYYY-MM" style={{ width: 110 }} />
        </Field>
        <Field label="Limit">
          <input value={limit} onChange={(e) => setLimit(e.target.value)} className="mono" />
        </Field>
        <Field label="Currency">
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Button variant="primary" onClick={submit} disabled={busy || !categoryId.trim()}>
          {busy ? "Saving…" : "Save budget"}
        </Button>
      </div>
    </Section>
  );
}
