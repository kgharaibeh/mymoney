import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { MoneyDTO } from "./api";
import { money, signClass } from "./format";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Minimal data-loading hook: runs `fn`, exposes state, and a reload(). */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // fn is intentionally excluded; callers pass a stable dependency list.
  const run = useCallback(() => {
    setLoading(true);
    setError(null);
    fn()
      .then((d) => setData(d))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => run(), [run]);
  return { data, error, loading, reload: run };
}

export function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>{title}</h2>
        {actions && <div className="card-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function Button({
  children,
  onClick,
  variant = "default",
  type = "button",
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "ghost" | "danger";
  type?: "button" | "submit";
  disabled?: boolean;
}) {
  return (
    <button className={cx("btn", `btn-${variant}`)} onClick={onClick} type={type} disabled={disabled}>
      {children}
    </button>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

export function MoneyText({ value, strong }: { value: MoneyDTO; strong?: boolean }) {
  return <span className={cx("money", signClass(value), strong && "money-strong")}>{money(value)}</span>;
}

export function Banner({ kind, children }: { kind: "error" | "info" | "success"; children: ReactNode }) {
  return <div className={cx("banner", `banner-${kind}`)}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "warn" | "bad" }) {
  return <span className={cx("pill", `pill-${tone}`)}>{children}</span>;
}
