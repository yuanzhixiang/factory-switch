import { useState } from "react";
import { Button } from "./Button";
import { Modal } from "./Modal";

/** 输入账号名字的弹窗，用于首次备份和改名 */
export function NameDialog({
  title,
  initialValue,
  onSubmit,
  onClose,
}: {
  title: string;
  initialValue: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialValue);
  const trimmed = name.trim();

  return (
    <Modal title={title} onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed) {
            onSubmit(trimmed);
          }
        }}
      >
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="例如：主号、测试号"
          className="rounded-md border border-border bg-card px-3 py-2 outline-none focus:border-primary"
        />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button type="submit" variant="primary" disabled={!trimmed}>
            保存
          </Button>
        </div>
      </form>
    </Modal>
  );
}
