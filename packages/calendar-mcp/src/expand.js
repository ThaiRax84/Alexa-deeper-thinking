// Turns the iCalendar text returned by iCloud into concrete occurrences,
// expanding recurring events (for example, a weekly class schedule).
import ical from "node-ical";

/**
 * @param {string} icsText  contents of one calendar object (.ics)
 * @param {Date} from
 * @param {Date} to
 * @returns {{uid: string, title: string, start: Date, end: Date, allDay: boolean, location?: string}[]}
 */
export function expandEvents(icsText, from, to) {
  const parsed = ical.sync.parseICS(icsText);
  const out = [];
  for (const ev of Object.values(parsed)) {
    if (ev.type !== "VEVENT" || ev.recurrenceid) continue; // overrides are applied below
    const allDay = ev.datetype === "date";
    const duration = (ev.end ?? ev.start) - ev.start;
    const base = {
      uid: ev.uid,
      title: typeof ev.summary === "string" ? ev.summary : ev.summary?.val ?? "(untitled)",
      allDay,
      location: typeof ev.location === "string" ? ev.location : undefined,
    };

    if (!ev.rrule) {
      const end = new Date(ev.start.getTime() + duration);
      if (ev.start < to && end > from) out.push({ ...base, start: ev.start, end });
      continue;
    }

    // Recurring event: generate every occurrence that overlaps the range.
    const lookback = new Date(from.getTime() - duration);
    for (const occ of ev.rrule.between(lookback, to, true)) {
      const key = occ.toISOString();
      const dayKey = key.slice(0, 10);
      if (ev.exdate && (ev.exdate[key] || ev.exdate[dayKey])) continue; // cancelled date
      const override = ev.recurrences?.[key] ?? ev.recurrences?.[dayKey];
      const start = override?.start ?? occ;
      const end = override?.end ?? new Date(occ.getTime() + duration);
      if (start < to && end > from) out.push({ ...base, start, end });
    }
  }
  return out;
}
