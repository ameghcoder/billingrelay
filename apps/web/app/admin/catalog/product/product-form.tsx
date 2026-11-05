"use client";

import { CATALOG_CURRENCIES, FIELD_TYPES, PRODUCT_KINDS, type CatalogProduct } from "@billingrelay/core/catalog";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ComponentProps } from "react";
import {
  Controller,
  get,
  useFieldArray,
  useForm,
  useWatch,
  type FieldPath,
  type UseFormReturn,
} from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { ApiFailureMessage, callAdminApi, type ApiFailure } from "@/components/admin-api";
import { KIND_LABELS, MONTHLY_CREDITS_RULE, PACK_CREDITS_RULE } from "../labels";
import {
  fromProduct,
  isUsableFieldKey,
  newField,
  newProduct,
  newVariant,
  productResolver,
  type FieldValues,
  type ProductValues,
} from "./form-values";

type ProductFormApi = UseFormReturn<ProductValues, unknown, CatalogProduct>;

function FormError({ form, name }: { form: ProductFormApi; name: string }) {
  const error: { message?: string } | undefined = get(form.formState.errors, name);
  return error?.message ? <p className="text-sm text-destructive">{error.message}</p> : null;
}

function TextInput({
  form,
  name,
  label,
  hint,
  ...input
}: { form: ProductFormApi; name: FieldPath<ProductValues>; label: string; hint?: string } & Omit<ComponentProps<typeof Input>, "form">) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} autoComplete="off" spellCheck={false} {...input} {...form.register(name)} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <FormError form={form} name={name} />
    </div>
  );
}

function SelectInput({
  form,
  name,
  label,
  options,
}: { form: ProductFormApi; name: FieldPath<ProductValues>; label: string; options: readonly { value: string; label: string }[] }) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={name}>{label}</Label>
      <NativeSelect id={name} className="w-full" {...form.register(name)}>
        {options.map((option) => (
          <NativeSelectOption key={option.value} value={option.value}>
            {option.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <FormError form={form} name={name} />
    </div>
  );
}

function CheckboxInput({ form, name, label }: { form: ProductFormApi; name: FieldPath<ProductValues>; label: string }) {
  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field }) => (
        <div className="flex items-center gap-2">
          <Checkbox id={name} checked={field.value === true} onCheckedChange={(checked) => field.onChange(checked === true)} />
          <Label htmlFor={name}>{label}</Label>
        </div>
      )}
    />
  );
}

const asOptions = (values: readonly string[]) => values.map((value) => ({ value, label: value }));

function FieldEditor({ form, index, onRemove }: { form: ProductFormApi; index: number; onRemove: () => void }) {
  const type = useWatch({ control: form.control, name: `fields.${index}.type` });
  const prefix = `fields.${index}` as const;
  return (
    <div className="grid gap-4 rounded-lg border p-4 md:grid-cols-3" data-testid={`field-${index}`}>
      <TextInput form={form} name={`${prefix}.key`} label="Key" placeholder="license" />
      <TextInput form={form} name={`${prefix}.label`} label="Label" placeholder="License" />
      <SelectInput form={form} name={`${prefix}.type`} label="Type" options={asOptions(FIELD_TYPES)} />
      {type === "enum" && (
        <TextInput form={form} name={`${prefix}.options`} label="Options" placeholder="standard, extended" hint="Separate with commas" />
      )}
      {(type === "number" || type === "integer") && (
        <>
          <TextInput form={form} name={`${prefix}.min`} label="Minimum" inputMode="decimal" />
          <TextInput form={form} name={`${prefix}.max`} label="Maximum" inputMode="decimal" />
        </>
      )}
      {type === "text" && (
        <>
          <TextInput form={form} name={`${prefix}.minLength`} label="Shortest length" inputMode="numeric" />
          <TextInput form={form} name={`${prefix}.maxLength`} label="Longest length" inputMode="numeric" />
        </>
      )}
      <div className="flex items-center justify-between gap-2 md:col-span-3">
        <CheckboxInput form={form} name={`${prefix}.required`} label="Every variant must have a value" />
        <Button type="button" variant="outline" size="sm" onClick={onRemove}>
          Remove field
        </Button>
      </div>
    </div>
  );
}

function AttributeInput({ form, variant, field }: { form: ProductFormApi; variant: number; field: FieldValues }) {
  const key = field.key.trim();
  const name = `variants.${variant}.attributes.${key}` as const;
  const label = field.label.trim() || key;
  if (field.type === "boolean") return <CheckboxInput form={form} name={name} label={label} />;
  if (field.type === "enum") {
    const options = field.options.split(",").map((option) => option.trim()).filter(Boolean);
    return <SelectInput form={form} name={name} label={label} options={[{ value: "", label: "Choose…" }, ...asOptions(options)]} />;
  }
  return <TextInput form={form} name={name} label={label} />;
}

function VariantEditor({
  form,
  index,
  kind,
  fields,
  onRemove,
}: {
  form: ProductFormApi;
  index: number;
  kind: ProductValues["kind"];
  fields: FieldValues[];
  onRemove?: () => void;
}) {
  const prefix = `variants.${index}` as const;
  return (
    <div className="grid gap-4 rounded-lg border p-4 md:grid-cols-2" data-testid={`variant-${index}`}>
      <TextInput form={form} name={`${prefix}.ref`} label="Ref" placeholder="extended-license" hint="Your code uses this at checkout" />
      <TextInput form={form} name={`${prefix}.name`} label="Name" placeholder="Extended" />
      {fields.filter((field) => isUsableFieldKey(field.key)).map((field, position) => (
        <AttributeInput key={`${position}:${field.key}`} form={form} variant={index} field={field} />
      ))}
      <TextInput form={form} name={`${prefix}.amount`} label="Price" placeholder="29.00" inputMode="decimal" />
      <SelectInput form={form} name={`${prefix}.currency`} label="Currency" options={asOptions(CATALOG_CURRENCIES)} />
      {kind !== "credit_pack" && (
        <TextInput
          form={form}
          name={`${prefix}.accessKey`}
          label={kind === "subscription" ? "Access granted" : "Access granted (optional)"}
          placeholder="pro"
          hint="Your app checks this key to unlock something"
        />
      )}
      {kind !== "one_time" && (
        <TextInput
          form={form}
          name={`${prefix}.credits`}
          label={kind === "subscription" ? "Credits each paid month (optional)" : "Credits"}
          inputMode="numeric"
          hint={kind === "subscription" ? MONTHLY_CREDITS_RULE : PACK_CREDITS_RULE}
        />
      )}
      <div className="md:col-span-2">
        <FormError form={form} name={`${prefix}.variantError`} />
      </div>
      {onRemove && (
        <div className="md:col-span-2">
          <Button type="button" variant="outline" size="sm" onClick={onRemove}>
            Remove variant
          </Button>
        </div>
      )}
    </div>
  );
}

export function ProductForm({
  baseVersion,
  products,
  editing,
}: {
  baseVersion: number;
  products: CatalogProduct[];
  editing: CatalogProduct | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const form = useForm<ProductValues, unknown, CatalogProduct>({
    resolver: productResolver,
    defaultValues: editing ? fromProduct(editing) : newProduct(),
  });
  const fieldArray = useFieldArray({ control: form.control, name: "fields" });
  const variantArray = useFieldArray({ control: form.control, name: "variants" });
  const kind = useWatch({ control: form.control, name: "kind" });
  const fields = useWatch({ control: form.control, name: "fields" });

  async function saveCatalog(nextProducts: CatalogProduct[]) {
    setBusy(true);
    setFailure(null);
    const result = await callAdminApi<{ version: number }>("/admin/config/drafts", {
      method: "POST",
      body: JSON.stringify({ baseVersion, config: { products: nextProducts } }),
    });
    if ("failure" in result) {
      setFailure(result.failure);
      setBusy(false);
    } else {
      router.push(`/admin/catalog?version=${result.body.version}`);
    }
  }

  const save = form.handleSubmit((product) =>
    saveCatalog(
      editing ? products.map((existing) => (existing.ref === editing.ref ? product : existing)) : [...products, product],
    ),
  );

  return (
    <form onSubmit={save} noValidate className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{editing ? `Edit ${editing.name}` : "Add product"}</h1>
        <p className="mt-2 text-muted-foreground">
          Saving creates version {baseVersion + 1}. What's live doesn't change until you make that version live.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Product</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <TextInput form={form} name="ref" label="Ref" placeholder="template" hint="Your code uses this at checkout" />
          <TextInput form={form} name="name" label="Name" placeholder="Creator template" />
          <SelectInput
            form={form}
            name="kind"
            label="Kind"
            options={PRODUCT_KINDS.map((value) => ({ value, label: KIND_LABELS[value] }))}
          />
          {kind === "subscription" ? (
            <p className="self-end text-sm text-muted-foreground">Billed monthly. Quantity is always 1, with one variant.</p>
          ) : (
            <TextInput form={form} name="maxQuantity" label="Most a customer can buy at once" inputMode="numeric" />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Custom fields</CardTitle>
          <CardDescription>
            Optional. They describe your variants, such as a license type. You set the values; buyers don't fill them in.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {fieldArray.fields.map((field, index) => (
            <FieldEditor key={field.id} form={form} index={index} onRemove={() => fieldArray.remove(index)} />
          ))}
          <FormError form={form} name="fieldsError" />
          <div>
            <Button type="button" variant="outline" onClick={() => fieldArray.append(newField())}>
              Add field
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Variants</CardTitle>
          <CardDescription>What the customer actually buys. A product with no options still has one.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {variantArray.fields.map((variant, index) => (
            <VariantEditor
              key={variant.id}
              form={form}
              index={index}
              kind={kind}
              fields={fields}
              onRemove={variantArray.fields.length > 1 ? () => variantArray.remove(index) : undefined}
            />
          ))}
          <FormError form={form} name="variantsError" />
          {kind !== "subscription" && (
            <div>
              <Button type="button" variant="outline" onClick={() => variantArray.append(newVariant())}>
                Add variant
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {failure && <ApiFailureMessage failure={failure} />}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? "Working…" : `Save as version ${baseVersion + 1}`}
        </Button>
        <Button variant="outline" asChild>
          <Link href="/admin/catalog">Cancel</Link>
        </Button>
        {editing && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => saveCatalog(products.filter((existing) => existing.ref !== editing.ref))}
          >
            Remove this product
          </Button>
        )}
      </div>
    </form>
  );
}
