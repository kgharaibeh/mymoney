import { useState } from "react";
import { api, setSession } from "../api";
import { Banner, Button, Field } from "../ui";

export function Auth({ onAuthed }: { onAuthed: (email: string) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = mode === "signup" ? await api.signup(email, password) : await api.login(email, password);
      setSession(res.token, res.user.email);
      onAuthed(res.user.email);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card card">
        <div className="brand" style={{ padding: "0 0 8px" }}>
          <span className="logo">MyMoney</span>
          <span className="tag">v0.1</span>
        </div>
        <h2 style={{ marginBottom: 4 }}>{mode === "signup" ? "Create your account" : "Welcome back"}</h2>
        <p style={{ color: "var(--muted)", marginTop: 0, marginBottom: 18 }}>
          {mode === "signup" ? "Sign up to start tracking your money." : "Log in to your MyMoney account."}
        </p>

        {error && <Banner kind="error">{error}</Banner>}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          style={{ display: "grid", gap: 14 }}
        >
          <Field label="Email">
            <input
              type="email"
              value={email}
              autoComplete="email"
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </Field>
          <Field label="Password">
            <input
              type="password"
              value={password}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === "signup" ? "At least 8 characters" : "Your password"}
            />
          </Field>
          <Button variant="primary" type="submit" disabled={busy || !email || !password}>
            {busy ? "Please wait…" : mode === "signup" ? "Create account" : "Log in"}
          </Button>
        </form>

        <p style={{ marginTop: 16, fontSize: "0.9rem", color: "var(--muted)" }}>
          {mode === "signup" ? "Already have an account? " : "New to MyMoney? "}
          <button
            type="button"
            className="btn btn-ghost"
            style={{ padding: 0, color: "var(--pine)" }}
            onClick={() => {
              setError(null);
              setMode(mode === "signup" ? "login" : "signup");
            }}
          >
            {mode === "signup" ? "Log in" : "Create one"}
          </button>
        </p>
      </div>
    </div>
  );
}
