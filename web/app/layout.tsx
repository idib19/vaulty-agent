import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Vaulty Agent Extension",
  description: "Vaulty Agent Extension",
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

