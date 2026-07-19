// Shared status-badge palette for anything showing a value against a
// user-defined range (device timeline gauges, fleet table cells). Kept in
// one place so both surfaces read as the same visual language instead of
// drifting into slightly different colors for the same meaning.
//
// `hex` is for Recharts SVG fill/stroke (can't take Tailwind classes);
// `className`/`badgeClassName` are full literal strings (not built via
// interpolation) since Tailwind's scanner needs to see the complete class
// name in source to generate it. `badgeClassName` is the outline style —
// border + tinted background + colored text reads better than
// white-on-color at these small badge sizes, especially against the dark
// gray "disabled" color where solid-fill white text had poor contrast.
export const GAUGE_COLORS = {
  cool: {
    hex: '#4299E1', // temp below target
    className: 'bg-device-cool',
    badgeClassName: 'border border-device-cool/40 bg-device-cool/10 text-device-cool',
  },
  dry: {
    hex: '#C05621', // humidity below target
    className: 'bg-device-dry',
    badgeClassName: 'border border-device-dry/40 bg-device-dry/10 text-device-dry',
  },
  good: {
    hex: '#48BB78',
    className: 'bg-device-good',
    badgeClassName: 'border border-device-good/40 bg-device-good/10 text-device-good',
  },
  alert: {
    hex: '#F56565',
    className: 'bg-device-alert',
    badgeClassName: 'border border-device-alert/40 bg-device-alert/10 text-device-alert',
  },
  neutral: {
    hex: '#333',
    className: 'bg-device-disabled',
    badgeClassName: 'border border-device-disabled/40 bg-device-disabled/10 text-device-disabled',
  },
};
