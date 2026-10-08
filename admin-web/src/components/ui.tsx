import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiError } from '../lib/api';

interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error';
}

const ToastContext = createContext<(message: string, kind?: Toast['kind']) => void>(
  () => undefined,
);

/** Brief confirmations ("Published version 3") and failures that aren't tied to a form. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const notify = useCallback((message: string, kind: Toast['kind'] = 'info') => {
    const id = nextId.current++;
    setToasts((current) => [...current, { id, message, kind }]);
    window.setTimeout(
      () => setToasts((current) => current.filter((toast) => toast.id !== id)),
      kind === 'error' ? 7000 : 3500,
    );
  }, []);

  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind === 'error' ? 'error' : ''}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

/** The message to show for anything a call can throw. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}

/**
 * Keeps a crash in one screen (a WebGL failure in the map, a chunk that failed to download after
 * a deploy) from blanking the whole app. Reset by changing `resetKey`, e.g. on navigation.
 */
export class ErrorBoundary extends Component<
  { resetKey: string; children: ReactNode },
  { error: Error | null; resetKey: string }
> {
  state = { error: null as Error | null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: { error: Error | null; resetKey: string },
  ) {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page">
        <div className="notice error">
          <div>
            <strong>This screen hit a problem and stopped.</strong>
            <div className="mono" style={{ marginTop: 4 }}>
              {this.state.error.message}
            </div>
          </div>
        </div>
        <div className="row">
          <button className="primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}
