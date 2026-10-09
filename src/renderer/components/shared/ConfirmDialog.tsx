import type { ReactNode } from "react";
import { Button } from "./Button";
import { Modal } from "./Modal";

/** 二次确认弹窗 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="flex flex-col gap-2 text-xs leading-5 text-secondary-foreground">
        {children}
      </div>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>取消</Button>
        <Button
          variant={danger ? "danger" : "primary"}
          autoFocus
          onClick={() => {
            onClose();
            onConfirm();
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
