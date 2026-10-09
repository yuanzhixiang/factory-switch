import { useEffect, useRef, type ReactNode } from "react";

/** 基于原生 dialog 的弹窗：自带焦点管理，Esc 关闭 */
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  // 挂载即以模态方式打开，组件卸载就随之关闭
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="m-auto w-[400px] rounded-[2px] border border-border bg-background p-0 text-foreground shadow-dialog"
    >
      <div className="flex flex-col gap-4 p-6">
        <h2 className="text-sm">{title}</h2>
        {children}
      </div>
    </dialog>
  );
}
