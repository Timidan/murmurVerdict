// The topbar is mounted once by the Router and never unmounts, so pages cannot
// pass it a crumb by prop. They portal one into its slot instead, which keeps
// the crumb owned by the page (and by the page's own loading/error branches).

import { createContext, useContext } from "react";
import { createPortal } from "react-dom";

export const CrumbSlotContext = createContext<HTMLElement | null>(null);

/** Renders its children into the persistent topbar's crumb slot. */
export function TopbarCrumb({ children }: { children: React.ReactNode }) {
  const slot = useContext(CrumbSlotContext);
  if (!slot) return null;
  return createPortal(children, slot);
}
