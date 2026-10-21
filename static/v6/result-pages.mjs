export function resultPageSize(width) {
  if (typeof width !== 'number' || !Number.isFinite(width) || width < 0) {
    throw new RangeError('width must be a finite non-negative number');
  }
  return width < 600 ? 6 : 12;
}

export function paginateResults(items, page = 0, pageSize = 12) {
  if (!Array.isArray(items)) throw new RangeError('items must be an array');
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new RangeError('pageSize must be a positive integer');
  }

  const total = items.length;
  const pageCount = Math.ceil(total / pageSize);
  const requestedPage = typeof page === 'number' && Number.isFinite(page)
    ? Math.floor(page)
    : 0;
  const currentPage = pageCount === 0
    ? 0
    : Math.max(0, Math.min(pageCount - 1, requestedPage));
  const start = currentPage * pageSize;
  const end = Math.min(start + pageSize, total);

  return {
    items: items.slice(start, end),
    page: currentPage,
    pageSize,
    pageCount,
    total,
    start,
    end,
  };
}
