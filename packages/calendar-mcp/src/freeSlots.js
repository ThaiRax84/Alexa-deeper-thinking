// Finds free time between busy events.
// Everything is computed in the user's time zone so "only 07:00–22:00" means local time.
import { DateTime, Interval } from "luxon";

/**
 * @param {{start: Date, end: Date}[]} busy  busy intervals
 * @param {object} opts
 * @param {string} opts.rangeStart  ISO start of the search
 * @param {string} opts.rangeEnd    ISO end of the search
 * @param {number} opts.durationMinutes  minimum slot length
 * @param {string} [opts.dayStart="07:00"]  earliest acceptable time each day
 * @param {string} [opts.dayEnd="22:00"]    latest acceptable time each day
 * @param {string} [opts.zone="America/Mexico_City"]
 * @returns {{start: string, end: string, minutes: number}[]}
 */
export function findFreeSlots(busy, opts) {
  const zone = opts.zone ?? "America/Mexico_City";
  const [sh, sm] = (opts.dayStart ?? "07:00").split(":").map(Number);
  const [eh, em] = (opts.dayEnd ?? "22:00").split(":").map(Number);
  const range = Interval.fromDateTimes(
    DateTime.fromISO(opts.rangeStart, { zone }),
    DateTime.fromISO(opts.rangeEnd, { zone })
  );
  if (!range.isValid) throw new Error("Invalid search range.");

  // 1. Merge overlapping busy intervals.
  const merged = [];
  for (const b of [...busy].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && b.start <= last.end) last.end = new Date(Math.max(last.end, b.end));
    else merged.push({ start: b.start, end: b.end });
  }
  const busyIntervals = merged.map((b) =>
    Interval.fromDateTimes(DateTime.fromJSDate(b.start, { zone }), DateTime.fromJSDate(b.end, { zone }))
  );

  // 2. Walk day by day: allowed window minus busy time.
  const slots = [];
  let day = range.start.startOf("day");
  while (day < range.end) {
    const window = Interval.fromDateTimes(
      day.set({ hour: sh, minute: sm }),
      day.set({ hour: eh, minute: em })
    ).intersection(range);
    if (window) {
      for (const free of window.difference(...busyIntervals)) {
        const minutes = free.length("minutes");
        if (minutes >= opts.durationMinutes) {
          slots.push({ start: free.start.toISO(), end: free.end.toISO(), minutes: Math.round(minutes) });
        }
      }
    }
    day = day.plus({ days: 1 });
  }
  return slots;
}
