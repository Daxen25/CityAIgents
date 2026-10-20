import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Agent City",
  description: "Supervised personal and business missions",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
