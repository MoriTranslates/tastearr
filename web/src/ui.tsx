import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

// ---------------------------------------------------------------- toasts

interface Toast { id: number; msg: string; error: boolean }
const ToastCtx = createContext<(msg: string, error?: boolean) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((msg: string, error = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, msg, error }]);
    if (!error) setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.error ? " err" : ""}`}>
            <span>{t.msg}</span>
            <button className="icon" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------------------------------------------------------------- inputs

/** Password-style field for secrets, with a show/hide toggle. */
export function SecretInput({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder?: string; label: string }) {
  const [show, setShow] = useState(false);
  return (
    <span className="secret">
      <input type={show ? "text" : "password"} value={value} placeholder={placeholder} aria-label={label} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
      <button type="button" className="ghost small" onClick={() => setShow(!show)} aria-label={show ? `Hide ${label}` : `Show ${label}`}>
        {show ? "Hide" : "Show"}
      </button>
    </span>
  );
}

/** Comma-separated list input that keeps what you type and only splits when you leave the field. */
export function ListInput({ value, onChange, placeholder, label }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; label: string }) {
  const [text, setText] = useState(value.join(", "));
  const last = useRef(value.join(", "));
  useEffect(() => {
    const v = value.join(", ");
    if (v !== last.current) setText(v);
    last.current = v;
  }, [value]);
  const commit = () => {
    const list = text.split(",").map((x) => x.trim()).filter(Boolean);
    last.current = list.join(", ");
    onChange(list);
  };
  return <input value={text} placeholder={placeholder} aria-label={label} onChange={(e) => setText(e.target.value)} onBlur={commit} />;
}

/** Number input that allows clearing while typing and clamps when you leave the field. */
export function NumberInput({ value, onChange, min, max, label }: { value: number; onChange: (v: number) => void; min: number; max: number; label: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <input
      type="number"
      inputMode="numeric"
      aria-label={label}
      min={min}
      max={max}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const n = Math.min(max, Math.max(min, Math.round(Number(text)) || min));
        setText(String(n));
        onChange(n);
      }}
    />
  );
}

/** Toggleable chips for picking several options (works on phones, unlike <select multiple>). */
export function Chips<T extends string | number>({ options, value, onChange, label }: { options: { id: T; label: string }[]; value: T[]; onChange: (v: T[]) => void; label: string }) {
  return (
    <div className="chips pickable" role="group" aria-label={label}>
      {options.map((o) => {
        const on = value.includes(o.id);
        return (
          <button type="button" key={String(o.id)} className={`chip${on ? " on" : ""}`} aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== o.id) : [...value, o.id])}>
            {o.label}
          </button>
        );
      })}
      {!options.length && <span className="muted small">None</span>}
    </div>
  );
}

export function Pill({ ok, children }: { ok: boolean | null; children: ReactNode }) {
  return <span className={`pill ${ok === null ? "" : ok ? "good" : "bad"}`}>{children}</span>;
}

export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · Tastearr`;
  }, [title]);
}

export function Spinner({ label }: { label: string }) {
  return (
    <p className="muted loading" role="status">
      <span className="spin" aria-hidden="true" /> {label}
    </p>
  );
}

export function relTime(ms: number) {
  const d = Math.round((Date.now() - ms) / 60_000);
  if (d < 1) return "just now";
  if (d < 60) return `${d} min ago`;
  if (d < 1440) return `${Math.round(d / 60)} h ago`;
  return `${Math.round(d / 1440)} days ago`;
}

/** Calendar-day difference in local time (today = 0, tomorrow = 1). */
export function dayDiff(ms: number) {
  const a = new Date();
  const b = new Date(ms);
  return Math.round((new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime() - new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()) / 86_400_000);
}

export function airLabel(ms: number) {
  const d = new Date(ms);
  const diff = dayDiff(ms);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Tomorrow ${time}`;
  if (diff > 1 && diff < 7) return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}
