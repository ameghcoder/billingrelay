"use client";

import { useSyncExternalStore } from "react";

const noSubscription = () => () => {};

/** Formats only in the browser: the server's time zone differs from the reader's, and the two would mismatch on hydration. */
export function LocalTime({ value }: { value: string }) {
  const inBrowser = useSyncExternalStore(noSubscription, () => true, () => false);
  return <time dateTime={value}>{inBrowser ? new Date(value).toLocaleString() : ""}</time>;
}
