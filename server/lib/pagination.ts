// Backend safety cap: bounds how much data a single request can pull back, without
// changing response shape (still a plain array) so no frontend changes are required.
// Real cursor/offset pagination with a paginated response envelope is a larger, separate
// change tracked in BACKLOG.md — this just stops unbounded full-table scans today.
export const DEFAULT_LIST_LIMIT = Number(process.env.DEFAULT_LIST_LIMIT) || 500;
const MAX_LIST_LIMIT = Number(process.env.MAX_LIST_LIMIT) || 2000;

export function parseLimitOffset(req: any): { limit: number; offset: number } {
  let limit = Number(req.query?.limit);
  let offset = Number(req.query?.offset);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIST_LIMIT;
  limit = Math.min(limit, MAX_LIST_LIMIT);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  return { limit, offset };
}

export const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

// Real page/sort pagination for list screens (see this file's header comment — the
// "larger, separate change" it referred to). Opt-in via the `page` query param: a route
// using this stays backward-compatible with any existing caller that fetches the plain
// array with no `page` param, and only returns the {rows, total, page, pageSize} envelope
// when a client actually asks for a page. `sortableColumns` is a whitelist — never accept
// a client-supplied column name directly into a query, both for safety and because most
// display columns aren't 1:1 with a real DB column (e.g. a joined/derived value).
export function parsePageSort<T extends string>(
  req: any,
  sortableColumns: Record<T, any>,
  defaultSortKey: T,
  defaultDir: 'asc' | 'desc' = 'asc'
): { page: number; pageSize: number; offset: number; sortBy: T; sortDir: 'asc' | 'desc' } {
  let page = Number(req.query?.page);
  if (!Number.isFinite(page) || page < 1) page = 1;
  let pageSize = Number(req.query?.pageSize);
  if (!Number.isFinite(pageSize) || pageSize <= 0) pageSize = DEFAULT_PAGE_SIZE;
  pageSize = Math.min(pageSize, MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;

  const requestedSort = String(req.query?.sortBy || '') as T;
  const sortBy = Object.prototype.hasOwnProperty.call(sortableColumns, requestedSort) ? requestedSort : defaultSortKey;
  const requestedDir = String(req.query?.sortDir || '').toLowerCase();
  const sortDir: 'asc' | 'desc' = requestedDir === 'asc' || requestedDir === 'desc' ? requestedDir : defaultDir;

  return { page, pageSize, offset, sortBy, sortDir };
}

// True whenever the request actually asked for a page (vs. an older/other caller hitting
// the same route expecting the original plain-array shape).
export function wantsPaged(req: any): boolean {
  return req.query?.page !== undefined;
}
