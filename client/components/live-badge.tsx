/**
 * The LIVE indicator — one of only four places racing red is permitted.
 *
 * Two densities, one component, so there is never a second live treatment
 * competing with this one.
 *
 * `compact` (the list): a red dot beside a white label. Used where many live
 * rows are on screen at once. At 400+ live matches the filled pill tiles into
 * an ambient wall of red, and ambient red stops meaning "look here" — which is
 * the exact failure the restraint rule exists to prevent. The dot keeps red
 * doing one job and keeps the surface calm by default.
 *
 * Default (a single match, e.g. the detail header): solid fill. #E10600 text
 * on the raised surface is 3.65:1 and fails AA at label size, while
 * --text-primary on #E10600 is 4.59:1 and passes. The pill is small enough
 * that filling it costs almost nothing when it is the only one on screen, and
 * it reads harder from a distance.
 *
 * The compact form sidesteps that contrast problem rather than inheriting it:
 * its label is --text-primary on the surface, and the red is carried by a 6px
 * dot, which is a non-text marker and not held to the 4.5:1 text threshold.
 * Do not "fix" the compact label to red.
 *
 * Status is never carried by color alone: the word Live ships with the dot in
 * both densities.
 */
export function LiveBadge({
  minute,
  compact = false,
}: {
  minute?: number;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-live animate-live-pulse" />
        <span className="type-caption leading-none text-fg">Live</span>
        {minute != null && (
          <span className="numeral text-[0.75rem] font-bold leading-none text-fg-secondary">
            {minute}&rsquo;
          </span>
        )}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-live py-0.5 pl-2 pr-2.5 text-fg">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-fg animate-live-pulse" />
      <span className="type-caption">Live</span>
      {minute != null && (
        <span className="numeral text-[0.8125rem] font-bold leading-none">{minute}&rsquo;</span>
      )}
    </span>
  );
}
