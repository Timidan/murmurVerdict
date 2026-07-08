import { cn } from "@/lib/utils";

/**
 * @efferd block convention: `<IconPlaceholder />` is a passthrough icon
 * stub the dashboard block embeds in cards / quick-actions / chart
 * headers. Real installs replace it with a brand icon (lucide-react,
 * Phosphor, custom SVG, etc.). For the first-cut Nothing-themed install
 * we render a tiny 12px square in muted-foreground so the layout is
 * preserved without committing to an icon family.
 */
/**
 * Accepts arbitrary string props (hugeicons/lucide/phosphor/remixicon/tabler/
 * data-icon) so block files using the @efferd icon-picker prop family don't
 * trigger TS errors; the stub ignores them all and renders the same square.
 */
export function IconPlaceholder({
  className,
  ...rest
}: { className?: string } & Record<string, unknown>) {
  void rest;
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block h-3 w-3 rounded-[2px] bg-muted-foreground/40",
        className,
      )}
    />
  );
}
