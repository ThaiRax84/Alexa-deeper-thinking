#!/usr/bin/env node
// MCP server that exposes iCloud (Apple Calendar) calendars as tools for AI agents.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DateTime } from "luxon";
import { listCalendars, listEvents, addEvent, deleteEvent } from "./icloud.js";
import { findFreeSlots } from "./freeSlots.js";
import { RRULE_PATTERN } from "./ics.js";

const ZONE = process.env.TZ_NAME || "America/Mexico_City";
if (!DateTime.now().setZone(ZONE).isValid) {
  console.error(`Invalid TZ_NAME: ${ZONE}. Use an IANA zone such as America/Mexico_City.`);
  process.exit(1);
}

const server = new McpServer({ name: "apple-calendar", version: "0.2.0" });

const local = (d) => DateTime.fromJSDate(new Date(d), { zone: ZONE }).toISO({ suppressMilliseconds: true });
const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (err) => ({ isError: true, content: [{ type: "text", text: String(err?.message ?? err) }] });
const wrap = (fn) => async (args) => {
  try {
    return ok(await fn(args));
  } catch (e) {
    return fail(e);
  }
};

const isoDate = z
  .string()
  .max(40)
  .describe(`ISO 8601 date-time with offset, e.g. 2026-11-10T07:00:00-06:00 (default zone ${ZONE})`);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const calendarNames = z.array(z.string().max(200)).max(50).optional();

server.registerTool(
  "list_calendars",
  {
    title: "List calendars",
    description: "Lists the user's iCloud event calendars.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  wrap(async () => (await listCalendars()).map(({ name, url }) => ({ name, url })))
);

server.registerTool(
  "list_events",
  {
    title: "List events",
    description: "Lists events between two dates, with recurring events expanded into occurrences.",
    inputSchema: {
      start: isoDate,
      end: isoDate,
      calendars: calendarNames.describe("Calendar names to include; empty means all"),
    },
    annotations: { readOnlyHint: true },
  },
  wrap(async (a) => (await listEvents(a)).map((e) => ({ ...e, start: local(e.start), end: local(e.end) })))
);

server.registerTool(
  "find_free_slots",
  {
    title: "Find free time",
    description: "Finds free slots of at least N minutes inside an allowed daily window.",
    inputSchema: {
      start: isoDate,
      end: isoDate,
      duration_minutes: z.number().int().min(5).max(1440),
      day_start: hhmm.default("07:00"),
      day_end: hhmm.default("22:00"),
      calendars: calendarNames.describe("Calendars that count as busy; empty means all"),
    },
    annotations: { readOnlyHint: true },
  },
  wrap(async (a) => {
    const events = await listEvents({ start: a.start, end: a.end, calendars: a.calendars });
    const busy = events.filter((e) => !e.allDay).map((e) => ({ start: e.start, end: e.end }));
    return findFreeSlots(busy, {
      rangeStart: a.start,
      rangeEnd: a.end,
      durationMinutes: a.duration_minutes,
      dayStart: a.day_start,
      dayEnd: a.day_end,
      zone: ZONE,
    });
  })
);

server.registerTool(
  "add_event",
  {
    title: "Add event",
    description: "Creates an event in an iCloud calendar, with optional notes, location and alert.",
    inputSchema: {
      calendar: z.string().max(200).describe("Exact calendar name (see list_calendars)"),
      title: z.string().min(1).max(500),
      start: isoDate,
      end: isoDate,
      notes: z.string().max(10_000).optional(),
      location: z.string().max(500).optional(),
      alarm_minutes_before: z.number().int().min(0).max(40_320).optional(),
      recurrence: z
        .string()
        .max(300)
        .regex(RRULE_PATTERN)
        .optional()
        .describe(
          "Optional RRULE to repeat the event, e.g. FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR or " +
            "FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20270508T235959Z. start/end describe the first occurrence."
        ),
    },
  },
  wrap(async (a) => addEvent({ ...a, alarmMinutesBefore: a.alarm_minutes_before, zone: ZONE }))
);

server.registerTool(
  "delete_event",
  {
    title: "Delete event",
    description:
      "Permanently deletes an event by its url (from list_events). Always confirm with the user first.",
    inputSchema: { url: z.string().max(2000), etag: z.string().max(200).optional() },
    annotations: { destructiveHint: true },
  },
  wrap(deleteEvent)
);

await server.connect(new StdioServerTransport());
