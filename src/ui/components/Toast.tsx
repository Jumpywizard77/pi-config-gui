import type { ToastKind } from "../App";

export interface ToastMessage {
  id: number;
  message: string;
  kind: ToastKind;
}

interface ToastProps {
  toasts: ToastMessage[];
  onDismiss: (id: number) => void;
}

/** Stack of transient notices; App auto-expires them, clicking dismisses. */
export function Toast({ toasts, onDismiss }: ToastProps) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast-${toast.kind}`}
          role="status"
          onClick={() => onDismiss(toast.id)}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}
