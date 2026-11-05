import type { CatalogProduct } from "@billingrelay/core/catalog";

export const KIND_LABELS: Record<CatalogProduct["kind"], string> = {
  one_time: "One-time",
  subscription: "Monthly subscription",
  credit_pack: "Credit pack",
};

export const MONTHLY_CREDITS_RULE =
  "Monthly credits last for the paid month and unused ones don't carry over. A customer who cancels keeps them until the paid month ends.";

export const PACK_CREDITS_RULE = "Pack credits never expire, and they're spent after any monthly credits.";
