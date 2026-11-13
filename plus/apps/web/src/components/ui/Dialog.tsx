import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";

import { Button } from "./Button.js";
import { Input } from "./Input.js";

interface DialogShellProps {
  readonly open: boolean;
  readonly title: string;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  readonly confirmLabel: string;
  readonly danger?: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  /** Return false to keep the dialog open and show a validation message. */
  readonly validate?: () => string | null;
}

const hasDialogElement = typeof HTMLDialogElement !== "undefined";
const lightDismissFallback =
  hasDialogElement && !("closedBy" in HTMLDialogElement.prototype);

function outside(dialog: HTMLDialogElement, event: PointerEvent): boolean {
  const rect = dialog.getBoundingClientRect();
  return (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  );
}

function DialogShell({
  open,
  title,
  description,
  children,
  confirmLabel,
  danger = false,
  onCancel,
  onConfirm,
  validate,
}: DialogShellProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const confirmed = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (typeof dialog.showModal !== "function") return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const onClose = (): void => {
      setError(null);
      if (confirmed.current) {
        confirmed.current = false;
        return;
      }
      onCancel();
    };
    dialog.addEventListener("close", onClose);
    return () => dialog.removeEventListener("close", onClose);
  }, [onCancel]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null || !lightDismissFallback) return;
    let pressedOutside = false;
    const onPointerDown = (event: PointerEvent): void => {
      pressedOutside = outside(dialog, event);
    };
    const onPointerUp = (event: PointerEvent): void => {
      if (pressedOutside && outside(dialog, event)) dialog.close();
      pressedOutside = false;
    };
    dialog.addEventListener("pointerdown", onPointerDown);
    dialog.addEventListener("pointerup", onPointerUp);
    return () => {
      dialog.removeEventListener("pointerdown", onPointerDown);
      dialog.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const message = validate?.() ?? null;
    if (message !== null) {
      setError(message);
      return;
    }
    confirmed.current = true;
    onConfirm();
    dialogRef.current?.close();
  }

  return (
    <dialog
      ref={dialogRef}
      className="ui-dialog"
      aria-labelledby={titleId}
      aria-describedby={description === undefined ? undefined : descriptionId}
      {...({ closedby: "any" } as Record<string, string>)}
    >
      <form className="ui-dialog__form" method="dialog" onSubmit={submit}>
        <div className="ui-dialog__heading">
          <h2 className="ui-dialog__title" id={titleId}>{title}</h2>
          {description === undefined ? null : (
            <p className="ui-dialog__copy" id={descriptionId}>{description}</p>
          )}
        </div>
        {children}
        {error === null ? null : <p className="ui-field__error" role="alert">{error}</p>}
        <div className="ui-dialog__actions">
          <Button type="button" variant="secondary" onClick={() => dialogRef.current?.close()}>
            取消
          </Button>
          <Button type="submit" variant={danger ? "danger" : "primary"}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </dialog>
  );
}

interface ReasonDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description?: ReactNode;
  readonly label: string;
  readonly defaultValue?: string;
  readonly confirmLabel: string;
  readonly onCancel: () => void;
  readonly onConfirm: (reason: string) => void;
}

export function ReasonDialog({
  open,
  title,
  description,
  label,
  defaultValue = "",
  confirmLabel,
  onCancel,
  onConfirm,
}: ReasonDialogProps) {
  const [reason, setReason] = useState(defaultValue);

  useEffect(() => {
    if (open) setReason(defaultValue);
  }, [open, defaultValue]);

  return (
    <DialogShell
      open={open}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      onCancel={onCancel}
      onConfirm={() => onConfirm(reason.trim())}
      validate={() => (reason.trim() === "" ? "请填写原因。" : null)}
    >
      <Input
        label={label}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        autoFocus
      />
    </DialogShell>
  );
}

interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description?: ReactNode;
  readonly confirmLabel: string;
  readonly danger?: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  danger,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <DialogShell
      open={open}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      danger={danger}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

