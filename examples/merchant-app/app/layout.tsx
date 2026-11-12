import type { ReactNode } from "react";
import "./styles.css";

export const metadata = { title: "Example shop" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
