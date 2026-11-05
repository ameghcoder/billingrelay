import { z } from "zod";

export const CATALOG_CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD"] as const;
export const PRODUCT_KINDS = ["one_time", "subscription", "credit_pack"] as const;
export const FIELD_TYPES = ["text", "number", "integer", "boolean", "enum"] as const;

export const MAX_PRICE = 99_999_999;
const MAX_CREDITS = 1_000_000_000;
const MAX_TEXT_LENGTH = 1_000;

// Control characters and broken Unicode would reach PayPal and the database as something other than what was sent.
export const hasUnsafeCharacters = (text: string) => /[\p{Cc}\p{Cs}]/u.test(text);

export const refSchema = z
  .string({ error: "Enter a ref" })
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "Use lowercase letters, numbers, - and _, up to 64 characters");

// Field keys become object keys in `attributes`, so the one name every object inherits is refused.
export const fieldKeySchema = z
  .string({ error: "Enter a key" })
  .regex(/^[a-z][a-z0-9_]{0,63}$/, "Use lowercase letters, numbers and _, starting with a letter")
  .refine((key) => key !== "constructor", "This name is reserved");

export const nameSchema = z
  .string({ error: "Enter a name" })
  .trim()
  .min(1, "Enter a name")
  .max(120)
  .refine((name) => !hasUnsafeCharacters(name), "Remove control characters");

export const priceSchema = z.strictObject({
  amount: z
    .int({ error: "Must be a whole number of minor units: 2900 means USD 29.00" })
    .positive("Must be more than 0")
    .max(MAX_PRICE, `Must be ${MAX_PRICE} or less`),
  currency: z.enum(CATALOG_CURRENCIES, { error: `Use ${CATALOG_CURRENCIES.join(", ")}` }),
});

export const accessBenefitSchema = z.strictObject({
  kind: z.literal("access", { error: "This product kind can't grant this benefit" }),
  key: refSchema,
});

const creditsBenefitSchema = z.strictObject({
  kind: z.literal("credits", { error: "This product kind can't grant this benefit" }),
  amount: z
    .int({ error: "Must be a whole number of credits" })
    .positive("Must be more than 0")
    .max(MAX_CREDITS, `Must be ${MAX_CREDITS} or less`),
});

export type CatalogBenefit = z.infer<typeof accessBenefitSchema> | z.infer<typeof creditsBenefitSchema>;

const fieldBase = {
  key: fieldKeySchema,
  label: z.string({ error: "Enter a label" }).trim().min(1, "Enter a label").max(80),
  required: z.boolean().default(false),
};

const lengthLimit = z.int({ error: "Must be a whole number" }).min(0).max(MAX_TEXT_LENGTH);

const fieldSchema = z.discriminatedUnion(
  "type",
  [
    z.strictObject({ ...fieldBase, type: z.literal("text"), minLength: lengthLimit.optional(), maxLength: lengthLimit.optional() }),
    z.strictObject({ ...fieldBase, type: z.literal("number"), min: z.number().optional(), max: z.number().optional() }),
    z.strictObject({ ...fieldBase, type: z.literal("integer"), min: z.int().optional(), max: z.int().optional() }),
    z.strictObject({ ...fieldBase, type: z.literal("boolean") }),
    z.strictObject({
      ...fieldBase,
      type: z.literal("enum"),
      options: z.array(z.string().trim().min(1).max(64)).min(1, "Add at least one option").max(20, "Up to 20 options"),
    }),
  ],
  { error: `Use ${FIELD_TYPES.join(", ")}` },
);
export type CatalogField = z.infer<typeof fieldSchema>;

const variantBase = {
  ref: refSchema,
  name: nameSchema,
  // Checked against the product's fields below, because the allowed values depend on them.
  attributes: z.record(z.string(), z.unknown()).default({}),
  price: priceSchema,
};

export const quantitySchema = z
  .int({ error: "Must be a whole number" })
  .min(1, "Must be 1 or more")
  .max(100, "Must be 100 or less")
  .default(1);

const productBase = {
  ref: refSchema,
  name: nameSchema,
  fields: z.array(fieldSchema).max(10, "Up to 10 fields").default([]),
};

const MAX_VARIANTS = 20;

export const catalogProductSchema = z
  .discriminatedUnion(
    "kind",
    [
      z.strictObject({
        ...productBase,
        kind: z.literal("one_time"),
        maxQuantity: quantitySchema,
        variants: z
          .array(z.strictObject({ ...variantBase, benefits: z.array(accessBenefitSchema).max(1, "Up to one access benefit") }))
          .min(1, "Add at least one variant")
          .max(MAX_VARIANTS, `Up to ${MAX_VARIANTS} variants`),
      }),
      z.strictObject({
        ...productBase,
        kind: z.literal("credit_pack"),
        maxQuantity: quantitySchema,
        variants: z
          .array(z.strictObject({ ...variantBase, benefits: z.array(creditsBenefitSchema).length(1, "A credit pack grants credits") }))
          .min(1, "Add at least one variant")
          .max(MAX_VARIANTS, `Up to ${MAX_VARIANTS} variants`),
      }),
      z.strictObject({
        ...productBase,
        kind: z.literal("subscription"),
        maxQuantity: z.literal(1, { error: "A subscription's quantity is always 1" }).default(1),
        variants: z
          .array(
            z.strictObject({
              ...variantBase,
              benefits: z.array(z.discriminatedUnion("kind", [accessBenefitSchema, creditsBenefitSchema])),
            }),
          )
          .length(1, "A subscription has exactly one variant, billed monthly"),
      }),
    ],
    { error: `Use ${PRODUCT_KINDS.join(", ")}` },
  )
  .superRefine((product, ctx) => {
    reportDuplicates(product.fields.map((field) => field.key), ["fields"], "key", ctx);
    reportDuplicates(product.variants.map((variant) => variant.ref), ["variants"], "ref", ctx);
    product.fields.forEach((field, index) => checkField(field, ["fields", index], ctx));

    // A field with broken limits has no meaningful attribute check; its own error comes first.
    if (ctx.issues.length > 0) return;

    const seen = new Set<string>();
    product.variants.forEach((variant, index) => {
      reportAttributeIssues(variant.attributes, product.fields, ["variants", index, "attributes"], ctx);

      const identity = JSON.stringify(Object.entries(variant.attributes).sort(([a], [b]) => a.localeCompare(b)));
      if (seen.has(identity)) {
        addIssue(ctx, ["variants", index, "attributes"], "Another variant has the same attributes. Add a field that tells them apart");
      }
      seen.add(identity);

      if (product.kind === "subscription") checkSubscriptionBenefits(variant.benefits, ["variants", index, "benefits"], ctx);
    });
  });
export type CatalogProduct = z.infer<typeof catalogProductSchema>;

export const catalogConfigSchema = z
  .strictObject({
    products: z.array(catalogProductSchema).min(1, "Add at least one product").max(50, "Up to 50 products"),
  })
  .superRefine((config, ctx) => {
    reportDuplicates(config.products.map((product) => product.ref), ["products"], "ref", ctx);
  });
export type CatalogConfig = z.infer<typeof catalogConfigSchema>;

type RefineContext = z.core.$RefinementCtx<unknown>;

function addIssue(ctx: RefineContext, path: PropertyKey[], message: string) {
  ctx.addIssue({ code: "custom", path, message });
}

function reportDuplicates(values: string[], base: PropertyKey[], key: string, ctx: RefineContext) {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) addIssue(ctx, [...base, index, key], `"${value}" is used more than once`);
    seen.add(value);
  });
}

function checkField(field: CatalogField, path: PropertyKey[], ctx: RefineContext) {
  if (field.type === "text" && field.minLength !== undefined && field.maxLength !== undefined && field.minLength > field.maxLength) {
    addIssue(ctx, [...path, "minLength"], "Must not be more than the maximum");
  }
  if ((field.type === "number" || field.type === "integer") && field.min !== undefined && field.max !== undefined && field.min > field.max) {
    addIssue(ctx, [...path, "min"], "Must not be more than the maximum");
  }
  if (field.type === "enum" && new Set(field.options).size !== field.options.length) {
    addIssue(ctx, [...path, "options"], "Options must be different from each other");
  }
}

function checkSubscriptionBenefits(benefits: { kind: "access" | "credits" }[], path: PropertyKey[], ctx: RefineContext) {
  const count = (kind: "access" | "credits") => benefits.filter((benefit) => benefit.kind === kind).length;
  if (count("access") !== 1) addIssue(ctx, path, "A subscription grants exactly one access benefit");
  if (count("credits") > 1) addIssue(ctx, path, "A subscription grants credits at most once");
}

function reportAttributeIssues(attributes: Record<string, unknown>, fields: CatalogField[], path: PropertyKey[], ctx: RefineContext) {
  for (const issue of attributesSchema(fields).safeParse(attributes).error?.issues ?? []) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) addIssue(ctx, [...path, key], "Not a field of this product");
    } else {
      const missing = !Object.hasOwn(attributes, String(issue.path[0]));
      addIssue(ctx, [...path, ...issue.path], missing ? "This product's fields require a value" : issue.message);
    }
  }
}

function fieldValueSchema(field: CatalogField) {
  switch (field.type) {
    case "text": {
      // No trim here: the JSON Schema can't express it, and the two must agree on every value.
      const minLength = field.minLength ?? (field.required ? 1 : 0);
      return z.string().min(minLength).max(field.maxLength ?? MAX_TEXT_LENGTH);
    }
    case "number":
    case "integer": {
      let value = field.type === "number" ? z.number() : z.int();
      if (field.min !== undefined) value = value.min(field.min);
      if (field.max !== undefined) value = value.max(field.max);
      return value;
    }
    case "boolean":
      return z.boolean();
    case "enum":
      return z.enum(field.options as [string, ...string[]]);
  }
}

/** The validator for a variant's attributes. The JSON Schema below comes from this same object, so they can't disagree. */
export function attributesSchema(fields: CatalogField[]) {
  return z.strictObject(
    Object.fromEntries(
      fields.map((field) => {
        const value = fieldValueSchema(field);
        return [field.key, field.required ? value : value.optional()];
      }),
    ),
  );
}

export const attributesJsonSchema = (fields: CatalogField[]) => z.toJSONSchema(attributesSchema(fields));

export type FieldIssue = { path: string; message: string };

/** Flattens Zod's issues so each one names an exact field, including each unknown key. */
export function toFieldIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.flatMap((issue) =>
    issue.code === "unrecognized_keys"
      ? issue.keys.map((key) => ({ path: [...issue.path, key].join("."), message: "This field isn't supported" }))
      : [{ path: issue.path.join("."), message: issue.message }],
  );
}

/** Past purchases of a ref mean what its kind meant then, so a different kind needs a new ref. */
export function findKindChanges(next: CatalogConfig, live: CatalogConfig | null): FieldIssue[] {
  const liveKinds = new Map(live?.products.map((product) => [product.ref, product.kind]));
  return next.products.flatMap((product, index) => {
    const liveKind = liveKinds.get(product.ref);
    return liveKind && liveKind !== product.kind
      ? [{
          path: `products.${index}.kind`,
          message: `"${product.ref}" is ${liveKind} in the live version. Use a new ref for a different kind`,
        }]
      : [];
  });
}

export const saveCatalogDraftSchema = z.strictObject({
  baseVersion: z.int({ error: "Send the version this edit started from" }).min(0),
  config: catalogConfigSchema,
});

export const catalogVersionSummarySchema = z.object({
  id: z.string(),
  version: z.number(),
  isLive: z.boolean(),
  productCount: z.number(),
  createdAt: z.string(),
});
export type CatalogVersionSummary = z.infer<typeof catalogVersionSummarySchema>;

export const catalogVersionDetailSchema = catalogVersionSummarySchema.extend({
  // Not re-validated: an old version must stay readable even if the rules get stricter later.
  config: z.custom<CatalogConfig>(),
  attributeSchemas: z.array(z.object({ productRef: z.string(), schema: z.record(z.string(), z.unknown()) })),
});
export type CatalogVersionDetail = z.infer<typeof catalogVersionDetailSchema>;

export function toAttributeSchemas(config: CatalogConfig): CatalogVersionDetail["attributeSchemas"] {
  return config.products.map((product) => ({ productRef: product.ref, schema: attributesJsonSchema(product.fields) }));
}

/** `formatPrice(2900, "USD")` is "$29.00". All catalog currencies have two decimal places. */
export const formatPrice = (amount: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount / 100);

/** "29.90" becomes 2990. Whole-number arithmetic, because 19.99 * 100 isn't 1999 in floating point. */
export function minorUnitsFromText(text: string): number | null {
  const match = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

export const textFromMinorUnits = (amount: number) => `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, "0")}`;
