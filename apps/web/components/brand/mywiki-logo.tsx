/**
 * The myWiki mark: a brain and a document split down the middle.
 *
 * Earlier drafts drew the brain *inside* the page. That never worked — a 1.75
 * stroke in a 24×24 box leaves roughly three usable lines across the page's
 * interior, so the brain collapsed into a blob (or, worse, read as a peach).
 * Splitting the box solves it: each half gets the full height, and the centre
 * stroke does double duty as the brain's longitudinal fissure and the page's
 * spine. What identifies each side is its silhouette — lobed and round on the
 * left, straight with a folded corner on the right — so the mark survives being
 * shrunk to the 20px it's actually rendered at in the header.
 *
 * Deliberately monochrome and stroke-only, in lucide's geometry (24×24 box,
 * 1.75 stroke, round joins) so it sits next to the app's icons without looking
 * like a foreign object. Everything is `currentColor`, which is what makes it
 * flip with the theme on its own — black on white, white on black, no second
 * asset and no dark-mode variant to keep in sync.
 */
export function MyWikiLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role="img"
      aria-label="myWiki"
    >
      {/* Left: one hemisphere. Four arcs of radius 4 over a notional radius-8
          semicircle, so each lobe bulges about a unit past the circle — enough
          to read as gyri, wide enough not to fill in when rasterised small. */}
      <path d="M12 4a4 4 0 0 0-5.66 2.34A4 4 0 0 0 4 12a4 4 0 0 0 2.34 5.66A4 4 0 0 0 12 20" />
      {/* Two inner ticks. The lobed outline carries the reading on its own;
          these only keep the hemisphere from looking hollow at larger sizes. */}
      <path d="M9.4 7.9a2.7 2.7 0 0 0-1.8 2.5" />
      <path d="M9.4 14.6a2.7 2.7 0 0 0-1.8 2.5" />
      {/* The shared edge: fissure on the left, page spine on the right. */}
      <path d="M12 4v16" />
      {/* Right: the page, with the folded corner that still reads as
          "document" at 16px, where inner detail starts to disappear. */}
      <path d="M12 4h5l3 3v11a2 2 0 0 1-2 2h-6" />
      <path d="M17 4v2a1 1 0 0 0 1 1h2" />
    </svg>
  );
}
