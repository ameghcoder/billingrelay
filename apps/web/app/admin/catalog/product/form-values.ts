import {
  catalogProductSchema,
  fieldKeySchema,
  minorUnitsFromText,
  textFromMinorUnits,
  toCatalogIssues,
  type CatalogBenefit,
  type CatalogField,
  type CatalogProduct,
} from "@billingrelay/core/catalog";
import { get, set, type FieldErrors, type Resolver } from "react-hook-form";

/** What the inputs hold, as typed. The rules live in catalogProductSchema; this only converts between the two. */
export type FieldValues = {
  key: string;
  label: string;
  type: CatalogField["type"];
  required: boolean;
  options: string;
  min: string;
  max: string;
  minLength: string;
  maxLength: string;
};

export type VariantValues = {
  ref: string;
  name: string;
  attributes: Record<string, string | boolean>;
  amount: string;
  currency: string;
  accessKey: string;
  credits: string;
};

export type ProductValues = {
  ref: string;
  name: string;
  kind: CatalogProduct["kind"];
  maxQuantity: string;
  fields: FieldValues[];
  variants: VariantValues[];
};

export const newField = (): FieldValues => ({
  key: "",
  label: "",
  type: "text",
  required: false,
  options: "",
  min: "",
  max: "",
  minLength: "",
  maxLength: "",
});

export const newVariant = (): VariantValues => ({
  ref: "",
  name: "",
  attributes: {},
  amount: "",
  currency: "USD",
  accessKey: "",
  credits: "",
});

export const newProduct = (): ProductValues => ({
  ref: "",
  name: "",
  kind: "one_time",
  maxQuantity: "1",
  fields: [],
  variants: [newVariant()],
});

const textOf = (value: number | undefined) => (value === undefined ? "" : String(value));

export function fromProduct(product: CatalogProduct): ProductValues {
  return {
    ref: product.ref,
    name: product.name,
    kind: product.kind,
    maxQuantity: String(product.maxQuantity),
    fields: product.fields.map((field) => ({
      ...newField(),
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required,
      ...(field.type === "enum" && { options: field.options.join(", ") }),
      ...((field.type === "number" || field.type === "integer") && { min: textOf(field.min), max: textOf(field.max) }),
      ...(field.type === "text" && { minLength: textOf(field.minLength), maxLength: textOf(field.maxLength) }),
    })),
    variants: product.variants.map((variant) => {
      const benefits: CatalogBenefit[] = variant.benefits;
      return {
        ref: variant.ref,
        name: variant.name,
        attributes: Object.fromEntries(
          Object.entries(variant.attributes).map(([key, value]) => [key, typeof value === "boolean" ? value : String(value)]),
        ),
        amount: textFromMinorUnits(variant.price.amount),
        currency: variant.price.currency,
        accessKey: benefits.find((benefit) => benefit.kind === "access")?.key ?? "",
        credits: textOf(benefits.find((benefit) => benefit.kind === "credits")?.amount),
      };
    }),
  };
}

const optionalNumber = (text: string) => (text.trim() === "" ? undefined : Number(text));

function toField(field: FieldValues) {
  const base = { key: field.key.trim(), label: field.label, type: field.type, required: field.required };
  switch (field.type) {
    case "text":
      return { ...base, minLength: optionalNumber(field.minLength), maxLength: optionalNumber(field.maxLength) };
    case "number":
    case "integer":
      return { ...base, min: optionalNumber(field.min), max: optionalNumber(field.max) };
    case "enum":
      return { ...base, options: field.options.split(",").map((option) => option.trim()).filter(Boolean) };
    case "boolean":
      return base;
  }
}

export const isUsableFieldKey = (key: string) => fieldKeySchema.safeParse(key.trim()).success;

function toAttributes(fields: FieldValues[], variant: VariantValues) {
  const attributes: Record<string, string | number | boolean> = {};
  for (const field of fields.filter((candidate) => isUsableFieldKey(candidate.key))) {
    const key = field.key.trim();
    const value = variant.attributes[key];
    if (field.type === "boolean") attributes[key] = value === true;
    else if (typeof value === "string" && value !== "") {
      attributes[key] = field.type === "number" || field.type === "integer" ? Number(value) : value;
    }
  }
  return attributes;
}

function toBenefits(kind: ProductValues["kind"], variant: VariantValues) {
  const access = variant.accessKey.trim();
  const credits = variant.credits.trim();
  return [
    ...(kind !== "credit_pack" && access ? [{ kind: "access", key: access }] : []),
    ...(kind !== "one_time" && credits ? [{ kind: "credits", amount: Number(credits) }] : []),
  ];
}

export function toProductInput(values: ProductValues) {
  return {
    ref: values.ref.trim(),
    name: values.name,
    kind: values.kind,
    maxQuantity: values.kind === "subscription" ? 1 : optionalNumber(values.maxQuantity),
    fields: values.fields.map(toField),
    variants: values.variants.map((variant) => ({
      ref: variant.ref.trim(),
      name: variant.name,
      attributes: toAttributes(values.fields, variant),
      price: { amount: minorUnitsFromText(variant.amount), currency: variant.currency },
      benefits: toBenefits(values.kind, variant),
    })),
  };
}

const PRICE_TEXT_MESSAGE = "Enter an amount like 29.00, up to 999999.99";

/** Schema paths that aren't an input's own name, mapped to where the form shows them. */
function toFormError(path: string, message: string): { path: string; message: string } {
  const variant = /^variants\.(\d+)\.(.+)$/.exec(path);
  if (variant) {
    const [, index, rest = ""] = variant;
    if (rest === "price.amount") return { path: `variants.${index}.amount`, message: PRICE_TEXT_MESSAGE };
    if (rest === "price.currency") return { path: `variants.${index}.currency`, message };
    if (/^benefits\.\d+\.amount$/.test(rest)) return { path: `variants.${index}.credits`, message };
    if (/^benefits\.\d+\.key$/.test(rest)) return { path: `variants.${index}.accessKey`, message };
    if (rest === "attributes" || rest.startsWith("benefits")) return { path: `variants.${index}.variantError`, message };
  }
  const option = /^fields\.(\d+)\.options(\..+)?$/.exec(path);
  if (option) return { path: `fields.${option[1]}.options`, message };
  if (path === "variants" || path === "fields") return { path: `${path}Error`, message };
  return { path, message };
}

export const productResolver: Resolver<ProductValues, unknown, CatalogProduct> = async (values) => {
  const result = catalogProductSchema.safeParse(toProductInput(values));
  if (result.success) return { values: result.data, errors: {} };

  const errors: FieldErrors<ProductValues> = {};
  for (const issue of toCatalogIssues(result.error)) {
    const { path, message } = toFormError(issue.path, issue.message);
    if (!get(errors, path)) set(errors, path, { type: "validation", message });
  }
  return { values: {}, errors };
};
