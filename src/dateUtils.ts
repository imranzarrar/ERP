// Local-calendar-date formatting — deliberately not toISOString(), which formats in UTC
// and can show the wrong calendar date for timezones ahead of UTC (e.g. Saudi Arabia,
// UTC+3) during the hours after local midnight but before UTC midnight.
function toLocalDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Default date-range for report/listing filters across the app: 1st of the current
// calendar month through today.
export function getMonthToDateRange(): { start: string; end: string } {
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), 1);
  return { start: toLocalDateString(start), end: toLocalDateString(today) };
}
