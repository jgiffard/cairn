import type { Metadata } from 'next'
import { ThemeProvider } from 'next-themes'
import { display, mono, sans } from './fonts'
import './globals.css'

/**
 * Force request-time rendering for everything under the root layout.
 *
 * Without this, Next prerenders static pages (/login was one) at BUILD time
 * and bakes request state before the server can resolve a session.
 */
export const dynamic = 'force-dynamic'

const TITLE = 'Cairn'
const DESCRIPTION = 'Agent-first task tracker whose tasks double as shared memory.'

/**
 * Where relative metadata URLs — the opengraph-image among them — resolve.
 *
 * Read from CAIRN_BASE_URL, the same variable the CLI and .env.example already
 * use for "the public URL of this instance", rather than hardcoding one host:
 * Cairn is self-hosted, so the card has to point at whatever instance served
 * it. The localhost fallback only matters in development; without any
 * metadataBase Next emits a build warning and resolves the card against
 * localhost anyway.
 */
const baseUrl = process.env.CAIRN_BASE_URL || 'http://localhost:3000'

export const metadata: Metadata = {
  metadataBase: new URL(baseUrl),
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    type: 'website',
    siteName: TITLE,
    title: TITLE,
    description: DESCRIPTION,
    url: '/',
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
  },
}

const RootLayout = ({ children }: { children: React.ReactNode }) => {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${sans.variable} ${mono.variable} ${display.variable}`}
    >
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          {children}
        </ThemeProvider>
      </body>
    </html>
  )
}

export default RootLayout
