import { FOCUSABLE, trapTarget } from "../lib/focus";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

// ---------------------------------------------------------------- toasts

interface Toast {
  id: number;
  msg: string;
  error: boolean;
  action?: { label: string; run: () => void };
}
type Push = (msg: string, error?: boolean, action?: Toast["action"]) => void;
const ToastCtx = createContext<Push>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback<Push>((msg, error = false, action) => {
    const id = Date.now() + Math.random();
    // Same error again (e.g. a service that's down): replace it instead of stacking.
    setToasts((t) => [...t.filter((x) => !(x.error && error && x.msg === msg)).slice(-2), { id, msg, error, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 12_000 : action ? 8000 : 4500);
  }, []);
  const close = (id: number) => setToasts((x) => x.filter((y) => y.id !== id));
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {/* Permanent live regions (screen readers ignore regions created on the fly): errors assertive, the rest polite. */}
      <div className="sr-only" role="alert">
        {toasts
          .filter((t) => t.error)
          .map((t) => t.msg)
          .join(". ")}
      </div>
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.error ? " err" : ""}`} aria-hidden={t.error || undefined}>
            <span>{t.msg}</span>
            {t.action && (
              <button
                className="primary"
                onClick={() => {
                  t.action!.run();
                  close(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button className="icon" aria-label="Dismiss" onClick={() => close(t.id)}>
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------------------------------------------------------------- dialogs

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // Kept in a ref so a parent re-render (a new onClose function) doesn't re-run the focus effect mid-use.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const controls = () => [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    controls()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current();
      if (e.key !== "Tab") return;
      // Keep Tab inside the dialog; if focus fell out (its element was removed), bring it back in.
      const target = trapTarget(controls(), document.activeElement, e.shiftKey);
      if (!target) return;
      e.preventDefault();
      target.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, []);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal card" role="dialog" aria-modal="true" aria-label={title} ref={ref} onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <h2>{title}</h2>
          <button className="icon" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ErrorBox({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div className="banner error-box" role="alert">
      <p>Something went wrong: {error}</p>
      <button onClick={retry}>Try again</button>
    </div>
  );
}

// ---------------------------------------------------------------- inputs

/** Password-style field for secrets, with a show/hide toggle. */
export function SecretInput({
  value,
  onChange,
  placeholder,
  label,
  readOnly,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label: string;
  readOnly?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <span className="secret">
      <input
        type={show ? "text" : "password"}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        autoComplete="off"
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
      />
      <button type="button" className="ghost small" onClick={() => setShow(!show)} aria-label={show ? `Hide ${label}` : `Show ${label}`}>
        {show ? "Hide" : "Show"}
      </button>
    </span>
  );
}

/** Comma-separated list input that keeps what you type and only splits when you leave the field. */
export function ListInput({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  label: string;
}) {
  const [text, setText] = useState(value.join(", "));
  const last = useRef(value.join(", "));
  useEffect(() => {
    const v = value.join(", ");
    if (v !== last.current) setText(v);
    last.current = v;
  }, [value]);
  const commit = () => {
    const list = text
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    last.current = list.join(", ");
    onChange(list);
  };
  return <input value={text} placeholder={placeholder} aria-label={label} onChange={(e) => setText(e.target.value)} onBlur={commit} />;
}

/** Number input that allows clearing while typing and clamps when you leave the field. */
export function NumberInput({
  value,
  onChange,
  min,
  max,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  label: string;
}) {
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
export function Chips<T extends string | number>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; label: string }[];
  value: T[];
  onChange: (v: T[]) => void;
  label: string;
}) {
  return (
    <div className="chips pickable" role="group" aria-label={label}>
      {options.map((o) => {
        const on = value.includes(o.id);
        return (
          <button
            type="button"
            key={String(o.id)}
            className={`chip${on ? " on" : ""}`}
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== o.id) : [...value, o.id])}
          >
            {on ? "✓ " : ""}
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

export function Spinner({ label }: { label: string }) {
  return (
    <p className="muted loading" role="status">
      <span className="spin" aria-hidden="true" /> {label}
    </p>
  );
}
