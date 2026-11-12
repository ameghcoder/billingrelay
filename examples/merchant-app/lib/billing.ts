import { createBillingRelay } from "@billingrelay/sdk";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} (see .env.example)`);
  return value;
};

export const billing = () => createBillingRelay({ baseUrl: required("BILLINGRELAY_URL"), apiKey: required("BILLINGRELAY_API_KEY") });

export const appUrl = () => required("EXAMPLE_APP_URL");

export const products = () =>
  (process.env.EXAMPLE_PRODUCTS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [productRef, variantRef] = entry.split(":");
      return { productRef: productRef!, variantRef };
    });
