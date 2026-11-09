// iCloud connection over CalDAV (the standard calendar protocol).
// Credentials come only from environment variables and are never logged or returned.
import { createDAVClient } from "tsdav";
import { expandEvents } from "./expand.js";
import { buildEvent } from "./ics.js";
import { assertOwnedEventUrl, isICloudHttps } from "./urlGuard.js";

const ICLOUD_CALDAV = "https://caldav.icloud.com";
const MAX_RANGE_DAYS = 400;
let clientPromise;

function getClient() {
  const username = process.env.ICLOUD_USERNAME;
  const password = process.env.ICLOUD_APP_PASSWORD;
  if (!username || !password) {
    throw new Error("ICLOUD_USERNAME or ICLOUD_APP_PASSWORD is missing from the server configuration.");
  }
  clientPromise ??= createDAVClient({
    serverUrl: ICLOUD_CALDAV,
    credentials: { username, password },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  }).catch(() => {
    clientPromise = undefined; // allow a retry on the next call
    throw new Error("Could not sign in to iCloud. Check the Apple ID and app-specific password.");
  });
  return clientPromise;
}

const nameOf = (cal) =>
  typeof cal.displayName === "string" ? cal.displayName : cal.url.split("/").filter(Boolean).at(-1);

/** Event calendars only (Reminders lists are excluded). */
export async function listCalendars() {
  const client = await getClient();
  const cals = await client.fetchCalendars();
  return cals
    .filter((c) => !c.components || c.components.includes("VEVENT"))
    .filter((c) => isICloudHttps(new URL(c.url)))
    .map((c) => ({ name: nameOf(c), url: new URL(c.url).href, raw: c }));
}

async function pickCalendars(names) {
  const all = await listCalendars();
  if (!names?.length) return all;
  const wanted = names.map((n) => n.toLowerCase());
  const found = all.filter((c) => wanted.includes(c.name.toLowerCase()));
  if (!found.length) throw new Error(`Calendar not found. Available: ${all.map((c) => c.name).join(", ")}`);
  return found;
}

function parseRange(start, end) {
  const from = new Date(start);
  const to = new Date(end);
  if (Number.isNaN(+from) || Number.isNaN(+to)) throw new Error("start and end must be valid ISO 8601 dates.");
  if (to <= from) throw new Error("end must be after start.");
  if ((to - from) / 86_400_000 > MAX_RANGE_DAYS) throw new Error(`Range is limited to ${MAX_RANGE_DAYS} days.`);
  return { from, to };
}

export async function listEvents({ start, end, calendars }) {
  const client = await getClient();
  const { from, to } = parseRange(start, end);
  const out = [];
  for (const cal of await pickCalendars(calendars)) {
    const objects = await client.fetchCalendarObjects({
      calendar: cal.raw,
      timeRange: { start: from.toISOString(), end: to.toISOString() },
    });
    for (const obj of objects) {
      if (!obj.data) continue;
      for (const ev of expandEvents(obj.data, from, to)) {
        out.push({ ...ev, calendar: cal.name, url: obj.url, etag: obj.etag });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export async function addEvent({ calendar, title, start, end, notes, location, alarmMinutesBefore, recurrence, zone }) {
  const client = await getClient();
  const { from, to } = parseRange(start, end);
  const [cal] = await pickCalendars([calendar]);
  const { uid, ics } = buildEvent({
    title, start: from, end: to, notes, location, alarmMinutesBefore, recurrence, zone,
  });
  const filename = `${uid.split("@")[0]}.ics`; // plain UUID: safe in any URL path
  const res = await client.createCalendarObject({ calendar: cal.raw, filename, iCalString: ics });
  if (!res.ok) throw new Error(`iCloud rejected the event (HTTP ${res.status}).`);
  return { uid, calendar: cal.name, url: new URL(filename, cal.url).href };
}

/**
 * Deletes one event. The URL must point inside one of the user's own iCloud calendars,
 * because the request carries the user's credentials: never send them to another host.
 */
export async function deleteEvent({ url, etag }) {
  const calendarUrls = (await listCalendars()).map((c) => c.url);
  const target = assertOwnedEventUrl(url, calendarUrls);
  const client = await getClient();
  const res = await client.deleteCalendarObject({ calendarObject: { url: target, etag } });
  if (!res.ok) throw new Error(`Could not delete the event (HTTP ${res.status}).`);
  return { deleted: target };
}
