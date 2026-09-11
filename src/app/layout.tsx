import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { loadPublicBranding } from "@/lib/data/app-data";
import { DEFAULT_COMPANY_NAME } from "@/lib/auth/constants";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  // Company name comes from the database — never hardcoded in the UI.
  const branding = await loadPublicBranding()
  const companyName = branding?.company_name || DEFAULT_COMPANY_NAME
  return {
    title: {
      default: companyName,
      template: `%s — ${companyName}`,
    },
    description: `Private billing and inventory workspace for ${companyName}.`,
    robots: { index: false, follow: false },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster richColors position="top-right" closeButton />
      </body>
    </html>
  );
}
