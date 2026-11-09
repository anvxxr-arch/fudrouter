import * as React from "react";

export type ToastTone = "info" | "ok" | "warn" | "danger";

export interface ToastData {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}

export interface ToastOptions {
  tone?: ToastTone;
  title: string;
  description?: string;
  /** Auto-dismiss after this many ms. Default 4500; 0 = stay until closed. */
  duration?: number;
}

interface ToastContextValue {
  toast: (opts: ToastOptions) => void;
  dismiss: (id: number) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

/**
 * Raises a toast. Returns the API { toast, dismiss } the provider uses;
 * components call useToast(). There is no framework here: one context, one
 * reducer, a timers map -- the whole surface a toast needs.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastData[]>([]);
  const timers = React.useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const nextId = React.useRef(1);

  const dismiss = React.useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) { clearTimeout(timer); timers.current.delete(id); }
  }, []);

  const toast = React.useCallback((opts: ToastOptions) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev.slice(-3), { id, tone: opts.tone ?? "info", title: opts.title, description: opts.description }]);
    const duration = opts.duration ?? 4500;
    if (duration > 0) {
      timers.current.set(id, setTimeout(() => dismiss(id), duration));
    }
  }, [dismiss]);

  React.useEffect(() => {
    const map = timers.current;
    return () => { map.forEach(clearTimeout); map.clear(); };
  }, []);

  return (
    <ToastContext.Provider value={{ toast, dismiss }}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastViewport({ toasts, onDismiss }: { toasts: ToastData[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toast-viewport" role="status" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone} fx-toast`} role={t.tone === "danger" ? "alert" : "status"}>
          <ToastBody t={t} />
          <button type="button" className="toast-close" onClick={() => onDismiss(t.id)} aria-label="Dismiss">
            <span aria-hidden="true">×</span>
          </button>
        </div>
      ))}
    </div>
  );
}

function ToastBody({ t }: { t: ToastData }) {
  return (
    <div className="toast-body">
      <span className="toast-title">{t.title}</span>
      {t.description ? <span className="toast-desc">{t.description}</span> : null}
    </div>
  );
}

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

/** Inline, non-transient status line (an "Uploading…" caption or a sync note).
 *  role="status" makes it a polite live region without a viewport. */
export function StatusLine({ tone = "info", children }: { tone?: ToastTone; children: React.ReactNode }) {
  return <p className={`status-line status-line-${tone}`} role="status">{children}</p>;
}
