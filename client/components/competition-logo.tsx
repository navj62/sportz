'use client';

import { useState } from 'react';
import Image from 'next/image';

/**
 * A crest or league badge, with a monogram fallback.
 *
 * The fallback triggers on TWO conditions: a null URL, and a URL that fails to
 * load. The second is defensive, not a fix for an observed failure — measured
 * against the live CDN, zero of ~1000 crest requests failed. It is here because
 * the page renders around a thousand third-party images and an empty box where
 * a crest should be reads as broken rather than minimal; initials at least
 * identify the team.
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
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <span
        className="flex shrink-0 items-center justify-center rounded-full bg-surface ring-1 ring-stroke"
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        <span
          className="numeral font-bold text-fg-secondary"
          style={{ fontSize: Math.max(9, Math.round(size * 0.36)) }}
        >
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
      onError={() => setFailed(true)}
      unoptimized
    />
  );
}
