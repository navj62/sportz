'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Detects a score CHANGE and reports which side changed.
 *
 * This is the piece the live feed was missing. The pages merged WebSocket
 * payloads with `{ ...match, ...update }`, so nothing anywhere knew whether a
 * score had changed or merely been re-sent — a goal arrived as a silent
 * in-place mutation, and the one authored motion moment in the design system
 * had no way to fire.
 *
 * It lives in the component rather than in the page's merge for two reasons:
 * the comparison is against what is CURRENTLY DISPLAYED, which is exactly what
 * a render already has; and it then works identically on the list and the
 * detail page without either of them orchestrating anything.
 *
 * `animate-score-flash` runs 1400ms. The flag is held slightly longer so the
 * class is removed after the animation has finished rather than mid-way, which
 * would snap the colour back.
 *
 * A first render never flashes: mounting a page with matches already in
 * progress is not a goal.
 */

const FLASH_MS = 1500;

export function useScoreFlash(homeScore: number, awayScore: number) {
  const previous = useRef<{ home: number; away: number } | null>(null);
  const [flash, setFlash] = useState<{ home: boolean; away: boolean }>({
    home: false,
    away: false,
  });

  useEffect(() => {
    const prev = previous.current;
    previous.current = { home: homeScore, away: awayScore };

    // First render — establish the baseline without announcing anything.
    if (prev === null) return;

    const home = homeScore !== prev.home;
    const away = awayScore !== prev.away;
    if (!home && !away) return;

    setFlash({ home, away });
    const timer = setTimeout(() => setFlash({ home: false, away: false }), FLASH_MS);
    return () => clearTimeout(timer);
  }, [homeScore, awayScore]);

  return flash;
}
