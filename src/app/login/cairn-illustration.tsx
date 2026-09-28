/**
 * A cairn on a trail: what the product is named for, drawn large for the one
 * page that has room for it. Stones in the instance's accent, lit from above,
 * settling into place one after another; a dotted path leads up to them.
 *
 * Pure SVG and CSS (`.login-stone` in globals.css), so it costs no script and
 * holds still for anyone who has asked for reduced motion.
 */
const STONES = [
  { cx: 120, cy: 228, rx: 92, ry: 24, r: 0 },
  { cx: 115, cy: 184, rx: 71, ry: 21, r: -4 },
  { cx: 124, cy: 145, rx: 54, ry: 18, r: 5 },
  { cx: 117, cy: 112, rx: 38, ry: 15, r: -6 },
  { cx: 121, cy: 86, rx: 22, ry: 11, r: 3 },
]

export const CairnIllustration = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 240 270" className={className} aria-hidden>
    <defs>
      <linearGradient id="login-stone" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style={{ stopColor: 'color-mix(in oklab, var(--accent) 78%, white)' }} />
        <stop offset="1" style={{ stopColor: 'color-mix(in oklab, var(--accent) 62%, var(--bg))' }} />
      </linearGradient>
      <radialGradient id="login-shadow" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stopColor="#000" stopOpacity="0.35" />
        <stop offset="1" stopColor="#000" stopOpacity="0" />
      </radialGradient>
    </defs>

    <path
      d="M-10 268 C 30 262, 20 246, 52 244 S 70 252, 88 250"
      fill="none"
      stroke="var(--fg-subtle)"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeDasharray="0.5 7"
      opacity="0.7"
    />
    <ellipse cx="122" cy="252" rx="104" ry="10" fill="url(#login-shadow)" />

    {STONES.map((s, i) => (
      <g key={i} className="login-stone" style={{ '--d': `${200 + i * 140}ms` } as React.CSSProperties}>
        <ellipse
          cx={s.cx}
          cy={s.cy}
          rx={s.rx}
          ry={s.ry}
          transform={`rotate(${s.r} ${s.cx} ${s.cy})`}
          fill="url(#login-stone)"
          stroke="rgb(255 255 255 / 0.14)"
          strokeWidth="1"
        />
        <ellipse
          cx={s.cx - s.rx * 0.18}
          cy={s.cy - s.ry * 0.45}
          rx={s.rx * 0.5}
          ry={s.ry * 0.22}
          transform={`rotate(${s.r} ${s.cx} ${s.cy})`}
          fill="white"
          opacity="0.16"
        />
      </g>
    ))}
  </svg>
)
