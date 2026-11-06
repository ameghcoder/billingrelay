import { checkoutMetadata, HostedCheckout } from "./hosted-checkout";

export const metadata = checkoutMetadata;

export default async function CheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ cancelled?: string }>;
}) {
  const [{ id }, { cancelled }] = await Promise.all([params, searchParams]);
  return <HostedCheckout id={id} returning={false} cancelled={cancelled !== undefined} />;
}
