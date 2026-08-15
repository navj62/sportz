import Image from 'next/image';

/**
 * A crest or league badge, with a monogram fallback.
 *
 * Every row from API-Football currently carries a logo URL, but the column is
 * nullable and the CDN is a third party, so the fallback is the default path
 * rather than an edge case. Initials come from the name so the fallback still
 * identifies the team — this is the treatment PRODUCT.md specified for the
 * period when no crests existed at all.
 */

function initialsOf(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .split(' ')
    .filter(Boolean);

  if (words.length === 0) return '—';
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words
    .slice(0, 3)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

export default function CompetitionLogo({
  src,
  name,
  size = 28,
}: {
  src: string | null;
  name: string;
  size?: number;
}) {
  if (!src) {
    return (
      <span
        className="flex shrink-0 items-center justify-center rounded-full bg-surface ring-1 ring-stroke"
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        <span className="numeral text-[0.625rem] font-bold text-fg-secondary">
          {initialsOf(name)}
        </span>
      </span>
    );
  }

  return (
    <Image
      src={src}
      alt=""
      width={size}
      height={size}
      className="shrink-0 object-contain"
      style={{ width: size, height: size }}
      unoptimized
    />
  );
}
