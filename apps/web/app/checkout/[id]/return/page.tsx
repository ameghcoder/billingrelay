import { checkoutMetadata, HostedCheckout } from "../hosted-checkout";

export const metadata = checkoutMetadata;

/** PayPal sends the browser here. Its query string is ignored: only the stored order counts, and only PayPal's own answer about it. */
export default async function CheckoutReturnPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <HostedCheckout id={id} returning cancelled={false} />;
}
