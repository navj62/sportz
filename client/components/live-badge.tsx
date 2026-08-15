/**
 * The LIVE indicator — one of only four places racing red is permitted.
 *
 * Solid fill rather than a tinted one: #E10600 text on the raised surface is
 * 3.65:1, which fails AA at label size, while --text-primary on #E10600 is
 * 4.59:1 and passes. The pill is small enough that filling it costs almost
 * nothing against the red budget, and it reads harder from a distance.
 *
 * Status is never carried by color alone: the word LIVE ships with the dot.
 */
export function LiveBadge({ minute }: { minute?: number }) {
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
