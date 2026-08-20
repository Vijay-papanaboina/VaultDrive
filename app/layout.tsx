import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { CryptoProvider } from "@/hooks/use-crypto";
import { QueryProvider } from "@/components/query-provider";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "VaultDrive — Encrypted Drive Viewer",
  description:
    "Browse your age-encrypted Google Drive files with metadata and requested file downloads decrypted entirely in your browser.",
  keywords: ["encrypted", "google drive", "age encryption", "privacy", "metadata viewer"],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} dark`}
    >
      <body className="min-h-screen bg-background text-foreground antialiased">
        <QueryProvider>
          <CryptoProvider>{children}</CryptoProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
