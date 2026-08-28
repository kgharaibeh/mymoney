import { useState } from "react";
import { api, type SyncResultDTO } from "../api";
import { Banner, Button, Empty, Field, Pill, Section, useAsync } from "../ui";

export function Banks() {
  const connections = useAsync(() => api.listConnections(), []);
  const rules = useAsync(() => api.listRules(), []);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const link = async () => {
    setError(null);
    setNotice(null);
    setBusy("link");
    try {
      const c = await api.startConnection("SANDBOX");
      setNotice(
        `Linked sandbox connection ${c.id.slice(0, 8)}… Consent URL: ${c.redirectUrl ?? "(none)"} — now Sync it.`,
      );
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
      setNotice(`Sync complete: linked ${r.accountsLinked} account(s), imported ${r.imported}, skipped ${r.skippedDuplicates}.`);
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
          <Button variant="primary" onClick={link} disabled={busy === "link"}>
            {busy === "link" ? "Linking…" : "Link a bank (Sandbox)"}
          </Button>
        }
      >
        {error && <Banner kind="error">{error}</Banner>}
        {notice && <Banner kind="success">{notice}</Banner>}
        {connections.data && connections.data.length === 0 && (
          <Empty>No connections yet. The Sandbox provider links a fake bank so you can try the full flow.</Empty>
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
