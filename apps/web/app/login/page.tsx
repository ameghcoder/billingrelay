import { redirect } from "next/navigation";
import { getOperator } from "@/lib/operator";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  if (await getOperator()) redirect("/admin");
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <LoginForm />
    </main>
  );
}
