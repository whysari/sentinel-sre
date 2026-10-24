import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sentinel-SRE · Multi-Agent Incident Triage Console",
  description:
    "Executive telemetry, PostgreSQL Wait-For Graph visualisation, zero-trust guardrail audit and cryptographic DR verification for the Sentinel-SRE platform.",
  applicationName: "Sentinel-SRE",
  authors: [{ name: "Sentinel-SRE" }],
  keywords: [
    "SRE",
    "incident triage",
    "PostgreSQL",
    "wait-for graph",
    "deadlock",
    "chaos engineering",
    "disaster recovery",
    "Next.js",
  ],
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#05070d",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-sentinel-void font-sans text-slate-200 antialiased">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-sky-500 focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
        >
          Skip to dashboard
        </a>
        <div id="main-content">{children}</div>
      </body>
    </html>
  );
}
