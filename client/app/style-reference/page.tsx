import { ArrowRightLeft } from 'lucide-react';
import { LiveBadge } from '@/components/live-badge';

/* ─────────────────────────────────────────────────────────────────────────────
   TEMPORARY — design-system reference sheet. Not a product surface.
   Hardcoded sample data, no fetching, no routing dependencies.
   Delete this route once the system is locked.
   ───────────────────────────────────────────────────────────────────────────── */

export const metadata = { title: 'Sportz — Design System' };

/* ── Event markers ─────────────────────────────────────────────────────────
   One 16px grid, one stroke weight. Goal and cards are authored SVG because
   they are objects specific to this sport; the substitution arrow comes from
   lucide at the same size and stroke. No emoji, ever. */

function GoalIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className="shrink-0">
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      {/* Regular pentagon, circumradius 3, centred on the circle. The previous
          path sat 0.86px high on the 16px grid, so the panel read off-centre at
          14px. Vertices are the true -90/-18/54/126/198° points. */}
      <path d="M8 5L10.85 7.07L9.76 10.43H6.24L5.15 7.07Z" fill="currentColor" />
    </svg>
  );
}

function CardIcon({ tone }: { tone: 'yellow' | 'red' }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className="shrink-0">
      <rect
        x="4.25"
        y="2.25"
        width="7.5"
        height="11.5"
        rx="1.5"
        fill="currentColor"
        /* --accent-dim reads at 2.32:1 on the card surface, which is not legible
           at 14px, so a red card takes the full accent. Event markers are inside
           the red allowance; the restraint is spent on the marker, not on chrome. */
        style={{ color: tone === 'yellow' ? 'var(--status-postponed)' : 'var(--accent)' }}
      />
    </svg>
  );
}

const MARKERS = [
  { key: 'goal', label: 'Goal', node: <GoalIcon />, tint: 'text-fg' },
  { key: 'yellow', label: 'Yellow card', node: <CardIcon tone="yellow" />, tint: '' },
  { key: 'red', label: 'Red card', node: <CardIcon tone="red" />, tint: '' },
  {
    key: 'sub',
    label: 'Substitution',
    node: <ArrowRightLeft size={14} strokeWidth={1.75} className="shrink-0" />,
    tint: 'text-fg-secondary',
  },
] as const;

/* ── Section header ────────────────────────────────────────────────────────
   The rule is a hairline, never the accent. Only the LIVE variant spends red,
   and only on a 6px dot. */

function SectionHeader({
  title,
  meta,
  live = false,
}: {
  title: string;
  meta?: string;
  live?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 mb-4">
      {live && (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-live animate-live-pulse" />
      )}
      <h2 className={`type-caption shrink-0 ${live ? 'text-fg' : 'text-fg-secondary'}`}>
        {title}
      </h2>
      <span className="h-px flex-1 bg-stroke" />
      {meta && <span className="numeral shrink-0 text-[0.8125rem] font-bold text-fg-secondary">{meta}</span>}
    </div>
  );
}

/* ── Match card ────────────────────────────────────────────────────────────
   Bento atom. Depth is the surface step: the live fixture sits one layer
   forward rather than wearing a colored border. */

function Monogram({ initials }: { initials: string }) {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface ring-1 ring-stroke">
      <span className="numeral text-[0.625rem] font-bold text-fg-secondary">{initials}</span>
    </span>
  );
}

type Side = { name: string; initials: string; score?: number; dim?: boolean; flash?: boolean };

function TeamRow({ side }: { side: Side }) {
  return (
    <div className="flex items-center gap-3">
      <Monogram initials={side.initials} />
      <span
        className={`type-body min-w-0 flex-1 truncate font-medium ${
          side.dim ? 'text-fg-secondary' : 'text-fg'
        }`}
      >
        {side.name}
      </span>
      {side.score != null && (
        <span
          className={`numeral w-6 text-right text-[1.625rem] font-extrabold leading-none ${
            side.flash ? 'animate-score-flash [animation-delay:900ms]' : ''
          } ${side.dim ? 'text-fg-secondary' : 'text-fg'}`}
        >
          {side.score}
        </span>
      )}
    </div>
  );
}

function MatchCard({
  competition,
  status,
  home,
  away,
  events,
  kickoff,
  elevated = false,
}: {
  competition: string;
  status: React.ReactNode;
  home: Side;
  away: Side;
  events?: { icon: React.ReactNode; minute: number; who: string; tint?: string }[];
  kickoff?: string;
  elevated?: boolean;
}) {
  return (
    <article
      className={`overflow-hidden rounded-[8px] ring-1 ring-stroke ${
        elevated ? 'bg-surface-elevated' : 'bg-surface-raised'
      }`}
    >
      <header className="flex items-center justify-between gap-3 px-4 pt-3 pb-2.5">
        <span className="type-caption min-w-0 truncate text-fg-secondary">{competition}</span>
        {status}
      </header>

      <div className="space-y-3 px-4 pb-4">
        <TeamRow side={home} />
        <TeamRow side={away} />
      </div>

      {kickoff && (
        <div className="border-t border-stroke px-4 py-2.5">
          <span className="type-label text-fg-secondary">{kickoff}</span>
        </div>
      )}

      {events && events.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-stroke px-4 py-2.5">
          {events.map((e) => (
            <span key={`${e.minute}-${e.who}`} className="flex items-center gap-1.5">
              <span className={e.tint ?? 'text-fg-secondary'}>{e.icon}</span>
              <span className="numeral text-[0.75rem] font-bold text-fg-secondary">{e.minute}&rsquo;</span>
              <span className="type-label text-fg-secondary">{e.who}</span>
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

/* ── Type scale ────────────────────────────────────────────────────────── */

const TYPE_SCALE = [
  { token: 'score', cls: 'type-score', spec: '52 / 800 / wdth 75 / -0.03em', sample: '2–1' },
  { token: 'display', cls: 'type-display', spec: '40 / 800 / wdth 75 / -0.025em', sample: 'Matchday' },
  { token: 'h1', cls: 'type-h1', spec: '28 / 700 / wdth 100 / -0.02em', sample: 'Champions League' },
  { token: 'h2', cls: 'type-h2', spec: '20 / 600 / wdth 100 / -0.01em', sample: 'Aston Villa' },
  {
    token: 'body',
    cls: 'type-body',
    spec: '15 / 400 / wdth 100',
    sample: 'Kvaratskhelia opened the scoring inside twenty minutes.',
  },
  { token: 'label', cls: 'type-label', spec: '13 / 500 / wdth 100', sample: 'Full time · Red Bull Arena' },
  { token: 'caption', cls: 'type-caption', spec: '11 / 600 / wdth 100 / +0.08em', sample: 'Live now' },
];

/* ── Colour tokens ─────────────────────────────────────────────────────── */

const SWATCH_GROUPS = [
  {
    group: 'Surface',
    note: 'Depth is the step between these three. Cards are not outlined.',
    items: [
      { token: '--bg-base', hex: '#0A0D11' },
      { token: '--bg-raised', hex: '#12161C' },
      { token: '--bg-elevated', hex: '#1A1F27' },
    ],
  },
  {
    group: 'Text',
    note: 'Never pure white — #FFF vibrates against near-black.',
    items: [
      { token: '--text-primary', hex: '#F4F6F8' },
      { token: '--text-secondary', hex: '#9BA3AD' },
      { token: '--text-muted', hex: '#5A626C' },
    ],
  },
  {
    group: 'Accent',
    note: 'Live state, score change, red card, one primary action. Nothing else.',
    items: [
      { token: '--accent', hex: '#E10600' },
      { token: '--accent-dim', hex: '#A80400' },
    ],
  },
  {
    group: 'Status',
    note: 'Deliberately not red except live — that is what keeps red meaningful.',
    items: [
      { token: '--status-live', hex: '#E10600' },
      { token: '--status-scheduled', hex: '#9BA3AD' },
      { token: '--status-finished', hex: '#5A626C' },
      { token: '--status-postponed', hex: '#D89614' },
      { token: '--status-cancelled', hex: '#D89614' },
    ],
  },
];

const SPACING = [4, 8, 12, 16, 24, 32];

export default function StyleReference() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-12 sm:py-16">
      {/* ── Masthead ─────────────────────────────────────────────────────── */}
      <header className="mb-14 flex flex-col gap-8 border-b border-stroke pb-10 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="type-display text-[clamp(3.25rem,11vw,5.5rem)] uppercase text-fg">
            Sportz
          </h1>
          <p className="type-label mt-3 max-w-[42ch] text-fg-secondary">
            Live football scores. The screen holds still so that one thing — a goal — can move.
          </p>
        </div>

        <dl className="grid shrink-0 grid-cols-[auto_1fr] gap-x-6 gap-y-2 sm:text-right">
          {[
            ['Typeface', 'Archivo · wdth 62–125'],
            ['Accent', 'Racing red E10600'],
            ['Ground', 'Near-black, three layers'],
          ].map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="type-caption self-center text-fg-secondary">{k}</dt>
              <dd className="type-label text-fg-secondary">{v}</dd>
            </div>
          ))}
        </dl>
      </header>

      {/* ── Live now ─────────────────────────────────────────────────────── */}
      <section className="mb-16">
        <SectionHeader title="Live now" meta="3" live />

        <div className="grid gap-3 md:grid-cols-3">
          <MatchCard
            elevated
            competition="UEFA Champions League"
            status={<LiveBadge minute={67} />}
            home={{ name: 'Aston Villa', initials: 'AVL', score: 2, flash: true }}
            away={{ name: 'Paris Saint-Germain', initials: 'PSG', score: 1 }}
            events={[
              { icon: <GoalIcon />, minute: 20, who: 'Kvaratskhelia', tint: 'text-fg' },
              { icon: <CardIcon tone="yellow" />, minute: 44, who: 'Zaïre-Emery' },
              { icon: <GoalIcon />, minute: 61, who: 'Doué', tint: 'text-fg' },
            ]}
          />

          <MatchCard
            competition="Premier League"
            status={
              <span className="type-caption rounded-full bg-surface-elevated px-2 py-0.5 text-fg-secondary">
                Full time
              </span>
            }
            home={{ name: 'Newcastle United', initials: 'NEW', score: 0, dim: true }}
            away={{ name: 'Brighton & Hove', initials: 'BHA', score: 3 }}
            events={[
              { icon: <GoalIcon />, minute: 12, who: 'Welbeck', tint: 'text-fg' },
              { icon: <ArrowRightLeft size={14} strokeWidth={1.75} />, minute: 70, who: 'Gross' },
            ]}
          />

          <MatchCard
            competition="Serie A"
            status={
              <span className="type-caption rounded-full bg-postponed/12 px-2 py-0.5 text-postponed">
                Postponed
              </span>
            }
            home={{ name: 'Atalanta', initials: 'ATA', dim: true }}
            away={{ name: 'Bologna', initials: 'BOL', dim: true }}
            kickoff="Was 20:45 · rescheduling to be confirmed"
          />
        </div>

        <p className="type-caption mt-4 text-fg-secondary">
          Sample data — fixtures, scores and scorers on this sheet are synthetic.
        </p>
      </section>

      {/* ── Type ─────────────────────────────────────────────────────────── */}
      <section className="mb-16">
        <SectionHeader title="Type scale" meta="Archivo" />

        <div className="rounded-[8px] bg-surface-raised ring-1 ring-stroke">
          {TYPE_SCALE.map((row, i) => (
            <div
              key={row.token}
              className={`flex flex-col gap-2 px-5 py-5 sm:flex-row sm:items-baseline sm:gap-6 ${
                i > 0 ? 'border-t border-stroke' : ''
              }`}
            >
              <div className="flex shrink-0 flex-col gap-1 sm:w-40">
                <span className="type-caption text-fg-secondary">{row.token}</span>
                <span className="numeral text-[0.6875rem] font-medium text-fg-secondary">
                  {row.spec}
                </span>
              </div>
              <p className={`${row.cls} min-w-0 text-fg`}>{row.sample}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Motion ───────────────────────────────────────────────────────── */}
      <section className="mb-16">
        <SectionHeader title="Score change" meta="1400ms" />

        <div className="flex flex-col gap-5 rounded-[8px] bg-surface-raised px-5 py-6 ring-1 ring-stroke sm:flex-row sm:items-center sm:gap-10">
          <span className="type-score animate-score-flash-demo shrink-0 text-fg">2</span>
          <p className="type-body max-w-[52ch] text-fg-secondary">
            The one authored moment in the system. A score that changes swells to
            118% and flushes to racing red, then settles back to primary over
            1.4s. Nothing else on the surface animates, which is what makes this
            readable from across a room. Suppressed under{' '}
            <span className="numeral font-semibold text-fg">prefers-reduced-motion</span>.
          </p>
        </div>
      </section>

      {/* ── Colour ───────────────────────────────────────────────────────── */}
      <section className="mb-16">
        <SectionHeader title="Colour tokens" meta="15" />

        <div className="grid items-start gap-3 sm:grid-cols-2">
          {SWATCH_GROUPS.map((g) => (
            <div key={g.group} className="rounded-[8px] bg-surface-raised p-5 ring-1 ring-stroke">
              <h3 className="type-caption text-fg-secondary">{g.group}</h3>
              <p className="type-label mt-1.5 mb-4 text-fg-secondary">{g.note}</p>

              <ul className="flex flex-col gap-2.5">
                {g.items.map((s) => (
                  <li key={s.token} className="flex items-center gap-3">
                    <span
                      className="h-6 w-6 shrink-0 rounded-[6px] ring-1 ring-stroke-strong"
                      style={{ backgroundColor: s.hex }}
                    />
                    <code className="type-label min-w-0 flex-1 truncate text-fg">{s.token}</code>
                    <span className="numeral text-[0.75rem] font-semibold text-fg-secondary">
                      {s.hex}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* ── Shape, spacing, markers ──────────────────────────────────────── */}
      <section className="mb-16">
        <SectionHeader title="Shape, spacing & markers" />

        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-[8px] bg-surface-raised p-5 ring-1 ring-stroke">
            <h3 className="type-caption mb-4 text-fg-secondary">Radius</h3>
            <div className="flex items-end gap-4">
              {[
                { r: '8px', label: 'card', size: 'h-14 w-14' },
                { r: '6px', label: 'inner', size: 'h-11 w-11' },
                { r: '999px', label: 'pill', size: 'h-6 w-14' },
              ].map((x) => (
                <div key={x.label} className="flex flex-col items-center gap-2">
                  <span
                    className={`${x.size} bg-fg-muted`}
                    style={{ borderRadius: x.r }}
                  />
                  <span className="type-caption text-fg-secondary">{x.label}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[8px] bg-surface-raised p-5 ring-1 ring-stroke">
            <h3 className="type-caption mb-4 text-fg-secondary">Spacing</h3>
            <ul className="flex flex-col gap-2">
              {SPACING.map((s) => (
                <li key={s} className="flex items-center gap-3">
                  <span className="numeral w-6 text-right text-[0.75rem] font-semibold text-fg-secondary">
                    {s}
                  </span>
                  <span className="h-2 rounded-[2px] bg-fg-secondary" style={{ width: s * 4 }} />
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-[8px] bg-surface-raised p-5 ring-1 ring-stroke">
            <h3 className="type-caption mb-4 text-fg-secondary">Event markers</h3>
            <ul className="flex flex-col gap-3">
              {MARKERS.map((m) => (
                <li key={m.key} className="flex items-center gap-2.5">
                  <span className={m.tint}>{m.node}</span>
                  <span className="type-label text-fg-secondary">{m.label}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <footer className="border-t border-stroke pt-6">
        <p className="type-label text-fg-muted">
          Temporary reference sheet — delete{' '}
          <code className="text-fg-secondary">app/style-reference/</code> once the system is locked.
        </p>
      </footer>
    </div>
  );
}
