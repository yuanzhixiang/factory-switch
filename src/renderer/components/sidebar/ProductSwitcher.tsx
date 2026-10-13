export type Product = "factory" | "cursor";

/** 仅切换页面，不触发任何账号操作。 */
export function ProductSwitcher({ product, disabled, onChange }: {
  product: Product;
  disabled: boolean;
  onChange: (product: Product) => void;
}) {
  return (
    <div className="mx-2 flex rounded-[2px] border border-border p-0.5" role="group" aria-label="选择应用">
      {(["factory", "cursor"] as const).map((item) => (
        <button
          key={item}
          type="button"
          aria-pressed={product === item}
          disabled={disabled}
          onClick={() => onChange(item)}
          className={`h-7 flex-1 rounded-[2px] transition-colors focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40 ${product === item ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"}`}
        >
          {item === "factory" ? "Factory" : "Cursor"}
        </button>
      ))}
    </div>
  );
}
