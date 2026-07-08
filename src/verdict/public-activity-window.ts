import {
  isoFromMs,
  nowIso,
} from "./time.js";

export const PUBLIC_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface PublicActivityWindow {
  served_at: string;
  since_iso: string;
}

export function publicActivityWindow(now: Date): PublicActivityWindow {
  return {
    served_at: nowIso(now),
    since_iso: isoFromMs(now.getTime() - PUBLIC_ACTIVITY_WINDOW_MS),
  };
}
