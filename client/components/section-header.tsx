import CompetitionLogo from '@/components/competition-logo';

/* Ported from the reference sheet. The rule is a hairline, never the accent.
   Only the LIVE variant spends red, and only on a 6px dot. */

export default function SectionHeader({
  title,
  meta,
  logoUrl,
  live = false,
  level = 2,
}: {
  title: string;
  meta?: string | number;
  logoUrl?: string | null;
  live?: boolean;
  /** The page's first section header is its h1 — "Live now" is the real title
      of this page, so it should not be an h2 under nothing. */
  level?: 1 | 2;
}) {
  const Heading = level === 1 ? 'h1' : 'h2';

  return (
    <div className="mb-4 flex items-center gap-3">
      {live && (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-live animate-live-pulse" />
      )}
      {logoUrl !== undefined && (
        <CompetitionLogo src={logoUrl} name={title} size={18} />
      )}
      <Heading
        className={`type-caption min-w-0 shrink truncate ${
          live ? 'text-fg' : 'text-fg-secondary'
        }`}
      >
        {title}
      </Heading>
      <span className="h-px flex-1 bg-stroke" />
      {meta != null && (
        <span className="numeral shrink-0 text-[0.8125rem] font-bold text-fg-secondary">
          {meta}
        </span>
      )}
    </div>
  );
}
