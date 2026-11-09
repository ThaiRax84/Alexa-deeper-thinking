// Builds a single event in iCalendar format (RFC 5545), the format iCloud stores.
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";

const utc = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const localStamp = (d, zone) => DateTime.fromJSDate(d, { zone }).toFormat("yyyyMMdd'T'HHmmss");

// Only the safe subset of RRULE syntax: no line breaks, no extra properties.
export const RRULE_PATTERN = /^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Z0-9,+\-]+)*$/;

const fmtOffset = (minutes) => {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}${String(abs % 60).padStart(2, "0")}`;
};

/**
 * VTIMEZONE for zones without daylight saving time (e.g. America/Mexico_City since 2022).
 * Zones with DST return null and rely on the server knowing the IANA TZID, as iCloud does.
 */
function fixedOffsetTimezone(zone, year) {
  const jan = DateTime.fromObject({ year, month: 1, day: 1 }, { zone });
  const jul = DateTime.fromObject({ year, month: 7, day: 1 }, { zone });
  if (jan.offset !== jul.offset) return null;
  const off = fmtOffset(jan.offset);
  return [
    "BEGIN:VTIMEZONE",
    `TZID:${zone}`,
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    `TZOFFSETFROM:${off}`,
    `TZOFFSETTO:${off}`,
    "END:STANDARD",
    "END:VTIMEZONE",
  ];
}

// Escape text values so user input can never inject extra iCalendar properties.
const esc = (s) =>
  String(s)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");

// Fold lines longer than 75 octets (RFC 5545 §3.1) without splitting UTF-8 characters.
function fold(line) {
  const parts = [];
  let current = "";
  let limit = 75;
  for (const ch of line) {
    if (Buffer.byteLength(current + ch) > limit) {
      parts.push(current);
      current = ch;
      limit = 74; // continuation lines start with a space
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.join("\r\n ");
}

/**
 * @param {{title: string, start: Date, end: Date, notes?: string, location?: string,
 *          alarmMinutesBefore?: number, recurrence?: string, zone?: string}} e
 *   recurrence: an RRULE value such as "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR". Recurring events are
 *   anchored to local time in `zone`, so "12:00 every weekday" stays 12:00 across offset changes.
 * @returns {{uid: string, ics: string}}
 */
export function buildEvent(e) {
  const uid = `${randomUUID()}@deeper-thinking`;
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//deeper-thinking//EN"];

  let timing;
  if (e.recurrence) {
    if (!RRULE_PATTERN.test(e.recurrence)) throw new Error("Invalid recurrence rule.");
    const zone = e.zone ?? "America/Mexico_City";
    const tz = fixedOffsetTimezone(zone, e.start.getUTCFullYear());
    if (tz) lines.push(...tz);
    timing = [
      `DTSTART;TZID=${zone}:${localStamp(e.start, zone)}`,
      `DTEND;TZID=${zone}:${localStamp(e.end, zone)}`,
      `RRULE:${e.recurrence}`,
    ];
  } else {
    timing = [`DTSTART:${utc(e.start)}`, `DTEND:${utc(e.end)}`];
  }

  lines.push(
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${utc(new Date())}`,
    ...timing,
    `SUMMARY:${esc(e.title)}`
  );
  if (e.notes) lines.push(`DESCRIPTION:${esc(e.notes)}`);
  if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
  if (e.alarmMinutesBefore != null) {
    lines.push(
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${esc(e.title)}`,
      `TRIGGER:-PT${Math.round(e.alarmMinutesBefore)}M`,
      "END:VALARM"
    );
  }
  lines.push("END:VEVENT", "END:VCALENDAR");
  return { uid, ics: lines.map(fold).join("\r\n") + "\r\n" };
}
