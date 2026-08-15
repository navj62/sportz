import type { Metadata } from 'next';
import './globals.css';
import WsStatus from '@/components/ws-status';
import { Archivo } from 'next/font/google';
import { cn } from '@/lib/utils';

/* Archivo is a variable font carrying BOTH a weight axis (100–900) and a width
   axis (62–125). Requesting `wdth` gives us the condensed display voice and the
   normal UI voice from one self-hosted file — set via `font-stretch`, which
   composes with `font-weight` (unlike font-variation-settings, which fights it). */
const archivo = Archivo({
  subsets: ['latin'],
  axes: ['wdth'],
  display: 'swap',
  variable: '--font-archivo',
});

const DIRECTION_CONTRACT = `<!--
THESIS: A live-score surface whose entire screen holds still so that one thing —
a goal — can move. Refuses the sports-dashboard arrangement of colored tiles,
league badges and competing accents.
OWN-WORLD: Near-black in three steps (#0A0D11 / #12161C / #1A1F27); depth from
the step, never an outline. Archivo alone, its 75%-width condensed cut reserved
for numerals. Racing red #E10600 as the only chromatic event, capped at ~5% of
screen. Amber for interrupted fixtures. 8px cards, 6px inner, pills only on status.
STORY: The visitor scans a calm column, sees at a glance which match is live,
and watches a score change announce itself without a refresh.
FIRST VIEWPORT: Wordmark at display scale top-left with system facts opposite;
below it a LIVE NOW rule, then three match cards — live card raised a layer,
red pulse and minute at its head, score in condensed 800.
FORM: Brief-pinned by the user; tokens locked before the run. No concept roll —
a pinned direction beats the roll. No seed key.
FINISH: unreviewed and undocumented is unfinished; this build ends with the
finish review, the verdict, and DESIGN.md
-->`;

export const metadata: Metadata = {
  title: 'Sportz — Live Scores',
  description: 'Live sports scores, match results, and commentary',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={cn('h-full dark', archivo.variable)}>
      <body className="min-h-full flex flex-col bg-surface text-fg">
        <div hidden dangerouslySetInnerHTML={{ __html: DIRECTION_CONTRACT }} />
        <header className="border-b border-stroke bg-surface-raised">
          {/* Shares the shell width with the page content — the header used to
              be max-w-5xl against a max-w-4xl page, so the wordmark and the
              match list sat on different left edges. */}
          <div className="mx-auto flex h-14 w-full max-w-280 items-center justify-between px-4">
            <a
              href="/"
              className="numeral text-[1.0625rem] font-extrabold uppercase tracking-[0.01em] text-fg"
            >
              Sportz
            </a>
            <WsStatus />
          </div>
        </header>
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
