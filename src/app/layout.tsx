import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Anikoto Scraper API",
  description: "REST API for scraping anikoto.net - anime streaming data",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
