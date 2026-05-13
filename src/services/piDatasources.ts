import streamDeck from "@elgato/streamdeck";

import { accountsService } from "./accounts.js";

type DatasourceRequest = { event?: string; isRefresh?: boolean };

export type DatasourceItem = { value: string; label: string; disabled?: boolean };

/**
 * Inspect an incoming sendToPlugin event and reply with account options if the
 * PI is asking for them. Returns true if handled. Safe to call from any
 * action's onSendToPlugin handler.
 */
export async function handleAccountDatasource(ev: {
  payload: unknown;
}): Promise<boolean> {
  const payload = ev.payload as DatasourceRequest | null | undefined;
  if (!payload || typeof payload !== "object") return false;
  const event = payload.event;
  if (event !== "getAccounts" && event !== "getAccountsIncludingActive") return false;

  const items: DatasourceItem[] = [];
  if (event === "getAccountsIncludingActive") {
    items.push({ value: "", label: "Active account" });
  }
  for (const acct of accountsService.list()) {
    const isActive = accountsService.activeSlug === acct.slug;
    items.push({
      value: acct.slug,
      label: `${acct.displayName}${isActive ? " ●" : ""}`,
    });
  }
  await streamDeck.ui.sendToPropertyInspector({ event, items });
  return true;
}
