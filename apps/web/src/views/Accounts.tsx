import { useState } from "react";
import { api, type AccountDTO, type ImportResultDTO } from "../api";
import { today } from "../format";
import { Banner, Button, Empty, Field, MoneyText, Section, useAsync } from "../ui";

const TYPES = ["checking", "savings", "credit_card", "cash", "loan", "investment", "asset"];
const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "AED", "SAR", "JOD", "CAD", "AUD", "INR"];

export function Accounts() {
  const accounts = useAsync(() => api.listAccounts(), []);
  const [selected, setSelected] = useState<AccountDTO | null>(null);

  return (
    <>
      <div className="page-head">
        <h1>Accounts</h1>
        <p>Create accounts, review the register, add transactions, and import CSV statements.</p>
      </div>

      <CreateAccount onCreated={() => accounts.reload()} />

      <Section title="Your accounts" actions={<Button onClick={() => accounts.reload()}>Refresh</Button>}>
        {accounts.error && <Banner kind="error">{accounts.error}</Banner>}
        {accounts.data && accounts.data.length === 0 && <Empty>No accounts yet.</Empty>}
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
                  <tr key={a.id} className="row-click" onClick={() => setSelected(a)}>
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

      {selected && (
        <AccountPanel
          account={selected}
          onChanged={() => accounts.reload()}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}

function CreateAccount({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("checking");
  const [currency, setCurrency] = useState("USD");
  const [opening, setOpening] = useState("0.00");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.createAccount({ name, type, currency, openingBalance: opening });
      setName("");
      setOpening("0.00");
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Add an account">
      {error && <Banner kind="error">{error}</Banner>}
      <div className="form-row">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Everyday" />
        </Field>
        <Field label="Type">
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace("_", " ")}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Currency">
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="Opening balance">
          <input value={opening} onChange={(e) => setOpening(e.target.value)} className="mono" />
        </Field>
        <Button variant="primary" onClick={submit} disabled={busy || !name.trim()}>
          {busy ? "Adding…" : "Add account"}
        </Button>
      </div>
    </Section>
  );
}

function AccountPanel({
  account,
  onChanged,
  onClose,
}: {
  account: AccountDTO;
  onChanged: () => void;
  onClose: () => void;
}) {
  const txns = useAsync(() => api.listTransactions(account.id), [account.id]);
  const refresh = () => {
    txns.reload();
    onChanged();
  };

  return (
    <Section
      title={`Register — ${account.name} (${account.currency})`}
      actions={<Button variant="ghost" onClick={onClose}>Close</Button>}
    >
      <AddTransaction account={account} onAdded={refresh} />

      {txns.error && <Banner kind="error">{txns.error}</Banner>}
      {txns.data && txns.data.length === 0 && <Empty>No transactions yet.</Empty>}
      {txns.data && txns.data.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Payee</th>
                <th>Category</th>
                <th>Status</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {txns.data.map((t) => (
                <tr key={t.id}>
                  <td className="mono">{t.date}</td>
                  <td>{t.payee}</td>
                  <td>{t.categoryId ?? (t.splits.length ? "(split)" : "—")}</td>
                  <td>{t.status}</td>
                  <td className="num">
                    <MoneyText value={t.amount} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ImportCsv account={account} onImported={refresh} />
    </Section>
  );
}

function AddTransaction({ account, onAdded }: { account: AccountDTO; onAdded: () => void }) {
  const [date, setDate] = useState(today());
  const [payee, setPayee] = useState("");
  const [amount, setAmount] = useState("-0.00");
  const [category, setCategory] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.createTransaction({
        accountId: account.id,
        date,
        amount,
        payee,
        categoryId: category.trim() || null,
      });
      setPayee("");
      setAmount("-0.00");
      setCategory("");
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginBottom: 18 }}>
      {error && <Banner kind="error">{error}</Banner>}
      <div className="form-row">
        <Field label="Date">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Payee">
          <input value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="Grocery store" />
        </Field>
        <Field label={`Amount (${account.currency})`}>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} className="mono" />
        </Field>
        <Field label="Category (optional)">
          <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="food" />
        </Field>
        <Button variant="primary" onClick={submit} disabled={busy || !payee.trim()}>
          {busy ? "Adding…" : "Add"}
        </Button>
      </div>
    </div>
  );
}

function ImportCsv({ account, onImported }: { account: AccountDTO; onImported: () => void }) {
  const [csv, setCsv] = useState("Date,Description,Amount\n2026-06-01,Coffee shop,-4.20");
  const [hasHeader, setHasHeader] = useState(true);
  const [dateCol, setDateCol] = useState("Date");
  const [payeeCol, setPayeeCol] = useState("Description");
  const [amountCol, setAmountCol] = useState("Amount");
  const [result, setResult] = useState<ImportResultDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const r = await api.importCsv({
        accountId: account.id,
        csv,
        hasHeader,
        mapping: { date: dateCol, payee: payeeCol, amount: amountCol },
      });
      setResult(r);
      onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details style={{ marginTop: 18 }}>
      <summary style={{ cursor: "pointer", color: "var(--pine)" }}>Import CSV statement</summary>
      <div style={{ marginTop: 12 }}>
        {error && <Banner kind="error">{error}</Banner>}
        {result && (
          <Banner kind={result.errors.length ? "info" : "success"}>
            Imported {result.imported}, skipped {result.skippedDuplicates} duplicate(s).
            {result.errors.length > 0 && ` ${result.errors.length} row error(s).`}
          </Banner>
        )}
        <Field label="CSV">
          <textarea rows={5} value={csv} onChange={(e) => setCsv(e.target.value)} />
        </Field>
        <div className="form-row" style={{ marginTop: 10 }}>
          <Field label="Date column">
            <input value={dateCol} onChange={(e) => setDateCol(e.target.value)} />
          </Field>
          <Field label="Payee column">
            <input value={payeeCol} onChange={(e) => setPayeeCol(e.target.value)} />
          </Field>
          <Field label="Amount column">
            <input value={amountCol} onChange={(e) => setAmountCol(e.target.value)} />
          </Field>
          <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
            <span className="field-label">Has header row</span>
          </label>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? "Importing…" : "Import"}
          </Button>
        </div>
      </div>
    </details>
  );
}
