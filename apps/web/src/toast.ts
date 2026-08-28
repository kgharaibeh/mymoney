// A tiny global toaster: modules call toast.success/error/info, and the
// <Toaster/> component subscribes and renders. No context/provider boilerplate.

export type ToastKind = "success" | "error" | "info";
export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

let toasts: Toast[] = [];
const listeners = new Set<(t: Toast[]) => void>();
let nextId = 1;

function emit(): void {
  for (const l of listeners) l(toasts);
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

function push(kind: ToastKind, message: string): void {
  const id = nextId++;
  toasts = [...toasts, { id, kind, message }];
  emit();
  setTimeout(() => dismissToast(id), 4500);
}

export function subscribeToasts(listener: (t: Toast[]) => void): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => {
    listeners.delete(listener);
  };
}

export const toast = {
  success: (message: string) => push("success", message),
  error: (message: string) => push("error", message),
  info: (message: string) => push("info", message),
};
