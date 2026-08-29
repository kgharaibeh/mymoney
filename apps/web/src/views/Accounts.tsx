import { useState, type ChangeEvent } from "react";
import { api, type AccountDTO, type ImportResultDTO } from "../api";
import { today } from "../format";
import { toast } from "../toast";
import { Banner, Button, ConfirmButton, Empty, Field, MoneyText, Section, Spinner, useAsync } from "../ui";

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
        {accounts.loading && <Spinner />}
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
      toast.success(`Added account "${name.trim()}".`);
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

  const archive = async () => {
    try {
      await api.archiveAccount(account.id);
      toast.success(`Archived "${account.name}".`);
      onChanged();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: string) => {
    try {
      await api.deleteTransaction(id);
      toast.success("Transaction deleted.");
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Section
      title={`Register — ${account.name} (${account.currency})`}
      actions={
        <>
          <ConfirmButton onConfirm={archive} confirmLabel="Archive">
            Archive account
          </ConfirmButton>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <AddTransaction account={account} onAdded={refresh} />

      {txns.loading && <Spinner />}
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
                <th></th>
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
                  <td className="num">
                    <ConfirmButton onConfirm={() => remove(t.id)} confirmLabel="Delete">
                      Delete
                    </ConfirmButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ImportCsv account={account} onImported={refresh} />
      <ImportOfx account={account} onImported={refresh} />
    </Section>
  );
}

function ImportOfx({ account, onImported }: { account: AccountDTO; onImported: () => void }) {
  const [busy, setBusy] = useState(false);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const ofx = await file.text();
      const r = await api.importOfx({ accountId: account.id, ofx });
      toast.success(`Imported ${r.imported} transaction(s) from ${file.name}, skipped ${r.skippedDuplicates}.`);
      if (r.errors.length) toast.info(`${r.errors.length} transaction(s) had issues and were skipped.`);
      onImported();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  };

  return (
    <details style={{ marginTop: 14 }}>
      <summary style={{ cursor: "pointer", color: "var(--pine)" }}>Import an OFX / QFX file</summary>
      <div style={{ marginTop: 12 }}>
        <p style={{ color: "var(--muted)", marginTop: 0, fontSize: "0.9rem" }}>
          Upload a bank statement in OFX or QFX format. Duplicate transactions are skipped automatically.
        </p>
        <input type="file" accept=".ofx,.qfx,text/plain" onChange={onFile} disabled={busy} />
        {busy && <Spinner label="Importing…" />}
      </div>
    </details>
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
      toast.success("Transaction added.");
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
      toast.success(`Imported ${r.imported} transaction(s).`);
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
