// Enlarge within the existing camera fitter, retaining a margin at every viewport.
export function framingScale(value) {
  const scale=Number(value);
  return Number.isFinite(scale)&&scale>0?Math.min(1.18,Math.max(1,scale)):1;
}
export function framingFill(fill,scale=1) {
  return Math.min(.96,fill*framingScale(scale));
}
