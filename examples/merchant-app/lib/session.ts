import { cookies } from "next/headers";

// A stand-in for your real login. What matters: the customer ID sent to BillingRelay comes from your session, never the browser.
const COOKIE = "example_user";

export async function currentUser(): Promise<string | null> {
  return (await cookies()).get(COOKIE)?.value ?? null;
}

export async function setUser(id: string | null) {
  const jar = await cookies();
  if (id) jar.set(COOKIE, id, { httpOnly: true, sameSite: "lax", path: "/" });
  else jar.delete(COOKIE);
}
