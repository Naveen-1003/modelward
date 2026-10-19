import { useSyncExternalStore } from "react";

// Tiny shared store for the sidebar's badges (pending sign-ups, review queue, ...).
// Dashboards publish; the sidebar reads. Cleared on logout.
let counts = {};
const listeners = new Set();

export function setNavCounts(patch) {
  const next = { ...counts, ...patch };
  if (Object.keys(next).every((k) => next[k] === counts[k]) && Object.keys(next).length === Object.keys(counts).length) return;
  counts = next;
  listeners.forEach((l) => l());
}
export const clearNavCounts = () => setNavCounts(Object.fromEntries(Object.keys(counts).map((k) => [k, 0])));

const subscribe = (l) => (listeners.add(l), () => listeners.delete(l));
export const useNavCounts = () => useSyncExternalStore(subscribe, () => counts);
