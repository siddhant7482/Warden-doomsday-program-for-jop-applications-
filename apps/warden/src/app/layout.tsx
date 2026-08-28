import type { Metadata } from "next";
import { Archivo, Archivo_Black, JetBrains_Mono, Newsreader } from "next/font/google";
import "./globals.css";

/* Three faces, three jobs. Archivo Black carries the numerals, Archivo
 * the interface voice, JetBrains Mono the data ledger — and Newsreader
 * only appears once the app starts issuing notices, so the typography
 * itself changes register as things get worse. */
const sans = Archivo({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-sans" });
const fat = Archivo_Black({ subsets: ["latin"], weight: "400", variable: "--font-fat" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500", "700"], variable: "--font-mono" });
const serif = Newsreader({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-serif" });

export const metadata: Metadata = {
  title: "Warden",
  description: "The enforcement arm of CommandHQ.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB" className={`${sans.variable} ${fat.variable} ${mono.variable} ${serif.variable}`}>
      <body>{children}</body>
    </html>
  );
}
