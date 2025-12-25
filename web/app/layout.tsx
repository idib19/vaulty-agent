import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Agent in Browser",
  description: "Browser automation agent backend",
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

