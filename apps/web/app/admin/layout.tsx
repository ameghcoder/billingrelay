import type { ReactNode } from "react";
import { requireOperatorPage } from "@/lib/operator";
import { SignOutButton } from "./sign-out-button";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const operator = await requireOperatorPage();
  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <span className="font-semibold">BillingRelay</span>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          {operator.email}
          <SignOutButton />
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
