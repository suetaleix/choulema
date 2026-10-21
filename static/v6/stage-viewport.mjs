// Fit the machine into a safe area while the renderer still covers the whole screen.
export function stageViewport(width, height, fov, insets = {}) {
  const w = Math.max(1, Number(width) || 1), h = Math.max(1, Number(height) || 1);
  const fraction = value => Math.min(.45, Math.max(0, Number(value) || 0));
  const left = fraction(insets.left), right = fraction(insets.right);
  const top = fraction(insets.top), bottom = fraction(insets.bottom);
  const safeWidth = w * (1 - left - right), safeHeight = h * (1 - top - bottom);
  return {
    width: w, height: h, safeWidth, safeHeight, aspect: safeWidth / safeHeight,
    fov: Math.atan(Math.tan(fov * Math.PI / 360) * safeHeight / h) * 360 / Math.PI,
    offsetX: w * (right - left) / 2, offsetY: h * (bottom - top) / 2,
  };
}
