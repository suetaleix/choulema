const SAMPLE_NAMES = [
  '重复姓名',
  '重复姓名',
  '这是一个用于检验姓名标签宽度的超长中文姓名样例',
  '中文样例姓名',
  '✨🎉 访客样例 🎉✨',
];

const SUPPORTED_COUNTS = new Set([1, 6, 12, 48, 100, 500, 1000]);

export function makeVisualCandidates(count) {
  if (!SUPPORTED_COUNTS.has(count)) {
    throw new RangeError(`Unsupported visual sample count: ${count}`);
  }

  return Array.from({ length: count }, (_, index) => ({
    id: `visual-candidate-${String(index + 1).padStart(4, '0')}`,
    name: SAMPLE_NAMES[index] ?? `测试参与者 ${String(index + 1).padStart(4, '0')}`,
    stock: 1,
    weight: 1,
    excluded: false,
    tags: [],
  }));
}
