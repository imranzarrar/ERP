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
