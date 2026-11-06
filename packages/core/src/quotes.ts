import { z } from "zod";
import {
  accessBenefitSchema,
  hasUnsafeCharacters,
  MAX_PRICE,
  nameSchema,
  priceSchema,
  PRODUCT_KINDS,
  quantitySchema,
  refSchema,
  type CatalogBenefit,
  type CatalogConfig,
} from "./catalog";

const MAX_METADATA_VALUES = 20;

const safeText = (text: string) => !hasUnsafeCharacters(text);

export const externalCustomerIdSchema = z
  .string({ error: "Send your app's ID for this customer" })
  .min(1, "Send your app's ID for this customer")
  .max(128, "Up to 128 characters")
  .refine((id) => id === id.trim() && safeText(id), "No spaces at either end and no control characters");

const metadataSchema = z
  .record(
    z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, "Use letters, numbers, - and _, starting with a letter"),
    z.string({ error: "Must be text" }).max(500, "Up to 500 characters").refine(safeText, "Remove control characters"),
  )
  .refine((metadata) => Object.keys(metadata).length <= MAX_METADATA_VALUES, `Up to ${MAX_METADATA_VALUES} values`);

const quoteOptions = {
  externalCustomerId: externalCustomerIdSchema,
  quantity: quantitySchema,
  expiresInSeconds: z.int({ error: "Must be a whole number" }).min(60, "Must be 60 or more").max(3600, "Must be 3600 or less").default(1800),
  metadata: metadataSchema.default({}),
};

/** The price comes from the live catalog, so sending one is refused. */
export const catalogQuoteRequestSchema = z.strictObject({
  ...quoteOptions,
  productRef: refSchema,
  variantRef: refSchema.optional(),
});

/**
 * The merchant has its own catalog and its backend names the price. Credits can't be granted
 * here: they come only from a reviewed catalog, so a leaked key can't create them.
 */
export const merchantQuoteRequestSchema = z.strictObject({
  ...quoteOptions,
  item: z.strictObject({ ref: refSchema, name: nameSchema }),
  unitAmount: priceSchema.shape.amount,
  currency: priceSchema.shape.currency,
  benefits: z.array(accessBenefitSchema).max(1, "Up to one access benefit").default([]),
});

type CatalogQuoteRequest = z.output<typeof catalogQuoteRequestSchema>;
type MerchantQuoteRequest = z.output<typeof merchantQuoteRequestSchema>;
export type QuoteRequest = CatalogQuoteRequest | MerchantQuoteRequest;
// A checkout prices the same way, with its own expiry.
type PricedRequest = Omit<CatalogQuoteRequest, "expiresInSeconds"> | Omit<MerchantQuoteRequest, "expiresInSeconds">;

/** `item` picks the form, so that form's strict rules can name any field that doesn't belong. */
export function parseQuoteRequest(body: unknown) {
  const isMerchant = typeof body === "object" && body !== null && "item" in body;
  return isMerchant ? merchantQuoteRequestSchema.safeParse(body) : catalogQuoteRequestSchema.safeParse(body);
}

export const checkQuoteRequestSchema = z.strictObject({ externalCustomerId: externalCustomerIdSchema });

export const quoteSnapshotSchema = z.object({
  source: z.enum(["catalog", "merchant"]),
  catalogVersion: z.number().nullable(),
  product: z.object({ ref: z.string(), name: z.string(), kind: z.enum(PRODUCT_KINDS) }),
  variant: z.object({ ref: z.string(), name: z.string(), attributes: z.record(z.string(), z.unknown()) }).nullable(),
  quantity: z.number(),
  unitAmount: z.number(),
  amount: z.number(),
  currency: z.string(),
  // Per unit, so 2 packs of 5,000 credits grant 10,000.
  benefits: z.array(z.custom<CatalogBenefit>()),
  metadata: z.record(z.string(), z.string()),
});
export type QuoteSnapshot = z.infer<typeof quoteSnapshotSchema>;

export const quoteResponseSchema = z.object({
  id: z.string(),
  externalCustomerId: z.string(),
  status: z.enum(["open", "expired"]),
  expiresAt: z.string(),
  snapshot: quoteSnapshotSchema,
});
export type QuoteResponse = z.infer<typeof quoteResponseSchema>;

export type QuoteRefusal = { code: string; message: string };
type PricedItem = Pick<QuoteSnapshot, "source" | "catalogVersion" | "product" | "variant" | "unitAmount" | "currency" | "benefits">;
type LiveCatalog = { version: number; config: CatalogConfig };

const refuse = (code: string, message: string): QuoteRefusal => ({ code, message });

function priceFromCatalog(request: Omit<CatalogQuoteRequest, "expiresInSeconds">, live: LiveCatalog | null): PricedItem | QuoteRefusal {
  if (!live) return refuse("no_live_catalog", "Nothing is live in this project's catalog yet");

  const product = live.config.products.find((candidate) => candidate.ref === request.productRef);
  if (!product) return refuse("unknown_product", `"${request.productRef}" isn't in the live catalog`);
  if (product.kind === "subscription") return refuse("not_quotable", `"${product.ref}" is a subscription, which starts from a PayPal plan`);

  const variants: { ref: string; name: string; attributes: Record<string, unknown>; price: { amount: number; currency: string }; benefits: CatalogBenefit[] }[] =
    product.variants;
  if (!request.variantRef && variants.length > 1) return refuse("variant_required", `"${product.ref}" has several variants, so send variantRef`);
  const variant = request.variantRef ? variants.find((candidate) => candidate.ref === request.variantRef) : variants[0];
  if (!variant) return refuse("unknown_variant", `"${request.variantRef}" isn't a variant of "${product.ref}"`);

  if (request.quantity > product.maxQuantity) return refuse("quantity_too_large", `"${product.ref}" allows up to ${product.maxQuantity}`);

  return {
    source: "catalog",
    catalogVersion: live.version,
    product: { ref: product.ref, name: product.name, kind: product.kind },
    variant: { ref: variant.ref, name: variant.name, attributes: variant.attributes },
    unitAmount: variant.price.amount,
    currency: variant.price.currency,
    benefits: variant.benefits,
  };
}

function priceFromMerchant(request: Omit<MerchantQuoteRequest, "expiresInSeconds">, live: LiveCatalog | null): PricedItem | QuoteRefusal {
  if (live?.config.products.some((product) => product.ref === request.item.ref)) {
    return refuse("product_in_catalog", `"${request.item.ref}" is in the live catalog, so its price comes from there. Send productRef instead`);
  }
  return {
    source: "merchant",
    catalogVersion: null,
    product: { ...request.item, kind: "one_time" },
    variant: null,
    unitAmount: request.unitAmount,
    currency: request.currency,
    benefits: request.benefits,
  };
}

/** Works out the price and what the purchase grants. The stored result is never recalculated. */
export function buildQuoteSnapshot(request: PricedRequest, live: LiveCatalog | null): { snapshot: QuoteSnapshot } | { refusal: QuoteRefusal } {
  const priced = "item" in request ? priceFromMerchant(request, live) : priceFromCatalog(request, live);
  if ("code" in priced) return { refusal: priced };

  const amount = priced.unitAmount * request.quantity;
  if (amount > MAX_PRICE) return { refusal: refuse("amount_too_large", `The total must be ${MAX_PRICE} minor units or less`) };

  return { snapshot: { ...priced, quantity: request.quantity, amount, metadata: request.metadata } };
}

/** The one rule for whether a stored quote can be used. Checkout calls this too. */
export function refuseQuoteUse(quote: { externalCustomerId: string; isExpired: boolean }, externalCustomerId: string): QuoteRefusal | null {
  if (quote.externalCustomerId !== externalCustomerId) return refuse("quote_customer_mismatch", "This quote belongs to another customer");
  if (quote.isExpired) return refuse("quote_expired", "This quote has expired. Create a new one with a new Idempotency-Key");
  return null;
}
