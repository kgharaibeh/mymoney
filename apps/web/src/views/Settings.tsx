import { useState } from "react";
import { api, getEmail, setSession } from "../api";
import { toast } from "../toast";
import { Banner, Button, ConfirmButton, Field, Section } from "../ui";

export function Settings() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const changePassword = async () => {
    setError(null);
    if (next !== confirm) {
      setError("New passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const res = await api.changePassword(current, next);
      setSession(res.token, res.user.email); // keep this session valid with the fresh token
      setCurrent("");
      setNext("");
      setConfirm("");
      toast.success("Password changed. Other sessions were signed out.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const logoutEverywhere = async () => {
    try {
      const res = await api.logoutEverywhere();
      setSession(res.token, res.user.email);
      toast.success("Signed out of all other sessions.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
        <p>Manage your account and sessions.</p>
      </div>

      <Section title="Account">
        <div className="stat" style={{ marginBottom: 4 }}>
          <span className="label">Signed in as</span>
          <span style={{ fontSize: "1.1rem", fontWeight: 600 }}>{getEmail()}</span>
        </div>
      </Section>

      <Section title="Change password">
        {error && <Banner kind="error">{error}</Banner>}
        <div className="form-row">
          <Field label="Current password">
            <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          </Field>
          <Field label="New password">
            <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </Field>
          <Field label="Confirm new password">
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          </Field>
          <Button variant="primary" onClick={changePassword} disabled={busy || !current || !next}>
            {busy ? "Saving…" : "Change password"}
          </Button>
        </div>
      </Section>

      <Section title="Sessions">
        <p style={{ color: "var(--muted)", marginTop: 0 }}>
          Sign out of every other device. This session stays active; all other tokens are revoked immediately.
        </p>
        <ConfirmButton onConfirm={logoutEverywhere} confirmLabel="Sign out everywhere">
          Sign out of all other sessions
        </ConfirmButton>
      </Section>
    </>
  );
}
