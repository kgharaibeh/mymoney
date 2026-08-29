import { useState } from "react";
import { api, type SyncResultDTO } from "../api";
import { toast } from "../toast";
import { Banner, Button, Empty, Field, Pill, Section, Spinner, useAsync } from "../ui";

const GCC_COUNTRIES = [
  { code: "AE", name: "United Arab Emirates" },
  { code: "SA", name: "Saudi Arabia" },
  { code: "BH", name: "Bahrain" },
  { code: "QA", name: "Qatar" },
  { code: "KW", name: "Kuwait" },
  { code: "OM", name: "Oman" },
  { code: "JO", name: "Jordan" },
  { code: "EG", name: "Egypt" },
  { code: "GB", name: "United Kingdom" },
];

export function Banks() {
  const connections = useAsync(() => api.listConnections(), []);
  const rules = useAsync(() => api.listRules(), []);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [country, setCountry] = useState("AE");

  // Real bank link via Salt Edge: redirect to the hosted connect widget.
  const linkBank = async () => {
    setError(null);
    setNotice(null);
    setBusy("link");
    try {
      const { redirectUrl } = await api.startHostedConnection(country);
      window.location.href = redirectUrl; // leaves the app; returns after linking
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const linkSandbox = async () => {
    setError(null);
    setNotice(null);
    setBusy("sandbox");
    try {
      const c = await api.startSandboxConnection("SANDBOX");
      setNotice(`Linked sandbox connection ${c.id.slice(0, 8)}… now Sync it.`);
      connections.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const sync = async (id: string) => {
    setError(null);
    setNotice(null);
    setBusy(id);
    try {
      const r: SyncResultDTO = await api.syncConnection(id);
      const msg = `Sync complete: linked ${r.accountsLinked} account(s), imported ${r.imported}, skipped ${r.skippedDuplicates}.`;
      setNotice(msg);
      toast.success(msg);
      connections.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (id: string) => {
    setBusy(id);
    try {
      await api.revokeConnection(id);
      toast.success("Connection revoked.");
      connections.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Banks</h1>
        <p>Link bank accounts through an aggregator and auto-categorize what syncs in.</p>
      </div>

      <Section
        title="Connections"
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <select value={country} onChange={(e) => setCountry(e.target.value)} title="Bank country">
              {GCC_COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
            <Button variant="primary" onClick={linkBank} disabled={busy === "link"}>
              {busy === "link" ? "Redirecting…" : "Link a bank"}
            </Button>
            <Button onClick={linkSandbox} disabled={busy === "sandbox"}>
              {busy === "sandbox" ? "…" : "Sandbox"}
            </Button>
          </div>
        }
      >
        {error && <Banner kind="error">{error}</Banner>}
        {notice && <Banner kind="success">{notice}</Banner>}
        {connections.loading && <Spinner />}
        {connections.data && connections.data.length === 0 && (
          <Empty>
            No connections yet. Pick your bank's country and click “Link a bank” to connect through Salt Edge, or use
            “Sandbox” to try the flow with a fake bank.
          </Empty>
        )}
        {connections.data && connections.data.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Status</th>
                  <th>Last synced</th>
                  <th className="num">Actions</th>
                </tr>
              </thead>
              <tbody>
                {connections.data.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.provider}</td>
                    <td>
                      <Pill tone={c.status === "active" ? "good" : c.status === "revoked" ? "bad" : "warn"}>
                        {c.status}
                      </Pill>
                    </td>
                    <td className="mono">{c.lastSyncedAt ?? "never"}</td>
                    <td className="num" style={{ whiteSpace: "nowrap" }}>
                      <Button onClick={() => sync(c.id)} disabled={busy === c.id || c.status === "revoked"}>
                        {busy === c.id ? "Syncing…" : "Sync"}
                      </Button>{" "}
                      <Button variant="danger" onClick={() => revoke(c.id)} disabled={busy === c.id || c.status === "revoked"}>
                        Revoke
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Rules rules={rules.data ?? []} error={rules.error} onChanged={() => rules.reload()} />
    </>
  );
}

function Rules({
  rules,
  error,
  onChanged,
}: {
  rules: Array<{ id: string; match: string; categoryId: string }>;
  error: string | null;
  onChanged: () => void;
}) {
  const [match, setMatch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const add = async () => {
    setFormError(null);
    setBusy(true);
    try {
      await api.addRule({ match, categoryId });
      toast.success("Rule added.");
      setMatch("");
      setCategoryId("");
      onChanged();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Auto-categorization rules">
      {error && <Banner kind="error">{error}</Banner>}
      {formError && <Banner kind="error">{formError}</Banner>}
      <div className="form-row">
        <Field label="If payee contains">
          <input value={match} onChange={(e) => setMatch(e.target.value)} placeholder="starbucks" />
        </Field>
        <Field label="Category">
          <input value={categoryId} onChange={(e) => setCategoryId(e.target.value)} placeholder="coffee" />
        </Field>
        <Button variant="primary" onClick={add} disabled={busy || !match.trim() || !categoryId.trim()}>
          {busy ? "Adding…" : "Add rule"}
        </Button>
      </div>

      {rules.length === 0 ? (
        <Empty>No rules yet. Rules apply to transactions pulled during a bank sync.</Empty>
      ) : (
        <table style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Payee contains</th>
              <th>Category</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.match}</td>
                <td>{r.categoryId}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}
