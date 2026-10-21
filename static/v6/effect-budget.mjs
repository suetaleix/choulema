const QUALITY_SCALE = Object.freeze({ high: 1, medium: .6, low: .3 });

function scaled(value, scale) {
  return Math.floor(value * scale);
}

export function effectBudget({
  width = 800,
  quality = 'high',
  cosmic = false,
  machine = 'capsule',
  phase = 'idle',
  reduced = false,
} = {}) {
  const viewportWidth = typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : 800;
  if (reduced === true) return { ambient: 0, stars: 0, burst: 0, trail: 0, total: 0 };

  const small = viewportWidth < 600;
  const running = phase === 'spin' || phase === 'reveal';
  const cosmicCapsule = cosmic === true && machine === 'capsule';
  const scale = Object.hasOwn(QUALITY_SCALE, quality) ? QUALITY_SCALE[quality] : QUALITY_SCALE.high;
  const ambientBase = cosmicCapsule
    ? (small ? (running ? 200 : 50) : (running ? 400 : 100))
    : (small ? (running ? 64 : 16) : (running ? 160 : 32));
  const starsBase = cosmicCapsule ? (small ? 110 : 220) : 0;
  const burstBase = cosmicCapsule
    ? (small ? 40 : 80)
    : (small ? 24 : 48);
  const ambient = scaled(ambientBase, scale);
  const stars = scaled(starsBase, scale);
  const burst = scaled(burstBase, scale);
  const trail = machine === 'wheel' ? 28 : 0;

  return { ambient, stars, burst, trail, total: ambient + stars + burst + trail };
}
