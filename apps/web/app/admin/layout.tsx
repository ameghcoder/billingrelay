import Link from "next/link";
import type { ReactNode } from "react";
import { requireOperatorPage } from "@/lib/operator";
import { SignOutButton } from "./sign-out-button";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const operator = await requireOperatorPage();
  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <nav className="flex items-center gap-6">
          <Link href="/admin" className="font-semibold">
            BillingRelay
          </Link>
          <Link href="/admin/paypal" className="text-sm text-muted-foreground hover:text-foreground">
            PayPal
          </Link>
          <Link href="/admin/catalog" className="text-sm text-muted-foreground hover:text-foreground">
            Catalog
          </Link>
        </nav>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          {operator.email}
          <SignOutButton />
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
