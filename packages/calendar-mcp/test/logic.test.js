import { test } from "node:test";
import assert from "node:assert/strict";
import ical from "node-ical";
import { findFreeSlots } from "../src/freeSlots.js";
import { expandEvents } from "../src/expand.js";
import { buildEvent } from "../src/ics.js";
import { assertOwnedEventUrl } from "../src/urlGuard.js";

const d = (s) => new Date(s);

test("free slots respect the daily window and busy events", () => {
  const busy = [
    { start: d("2026-11-10T07:00:00-06:00"), end: d("2026-11-10T09:00:00-06:00") },
    { start: d("2026-11-10T08:30:00-06:00"), end: d("2026-11-10T10:00:00-06:00") }, // overlaps
    { start: d("2026-11-10T13:00:00-06:00"), end: d("2026-11-10T14:00:00-06:00") },
  ];
  const slots = findFreeSlots(busy, {
    rangeStart: "2026-11-10T00:00:00-06:00",
    rangeEnd: "2026-11-11T00:00:00-06:00",
    durationMinutes: 60,
    dayStart: "07:00",
    dayEnd: "22:00",
  });
  assert.deepEqual(
    slots.map((s) => [s.start.slice(11, 16), s.end.slice(11, 16)]),
    [
      ["10:00", "13:00"],
      ["14:00", "22:00"],
    ]
  );
});

test("slots shorter than the requested duration are dropped", () => {
  const busy = [{ start: d("2026-11-10T07:30:00-06:00"), end: d("2026-11-10T22:00:00-06:00") }];
  const slots = findFreeSlots(busy, {
    rangeStart: "2026-11-10T00:00:00-06:00",
    rangeEnd: "2026-11-11T00:00:00-06:00",
    durationMinutes: 45,
  });
  assert.equal(slots.length, 0);
});

test("recurring events are expanded and cancelled dates are skipped", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:class-1",
    "DTSTART;TZID=America/Mexico_City:20270111T080000",
    "DTEND;TZID=America/Mexico_City:20270111T100000",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE",
    "EXDATE;TZID=America/Mexico_City:20270113T080000",
    "SUMMARY:Calculus",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\n");
  const occ = expandEvents(ics, d("2027-01-11T00:00:00-06:00"), d("2027-01-21T00:00:00-06:00"));
  assert.deepEqual(
    occ.map((o) => o.start.toISOString()),
    [
      "2027-01-11T14:00:00.000Z", // Mon 08:00 Mexico City
      "2027-01-18T14:00:00.000Z", // Wed the 13th is cancelled
      "2027-01-20T14:00:00.000Z",
    ]
  );
  assert.equal(occ[0].title, "Calculus");
});

test("generated event is valid iCalendar and keeps time, notes and alert", () => {
  const { ics } = buildEvent({
    title: "CUDA S1 — Theory",
    start: d("2026-11-09T07:00:00-06:00"),
    end: d("2026-11-09T09:00:00-06:00"),
    notes: "Read: Guide 1.1–1.3, with commas; and semicolons",
    alarmMinutesBefore: 15,
  });
  const ev = Object.values(ical.sync.parseICS(ics)).find((x) => x.type === "VEVENT");
  assert.equal(ev.start.toISOString(), "2026-11-09T13:00:00.000Z");
  assert.equal(ev.description, "Read: Guide 1.1–1.3, with commas; and semicolons");
  assert.match(ics, /TRIGGER:-PT15M/);
});

test("user text cannot inject iCalendar properties", () => {
  const { ics } = buildEvent({
    title: "Hi\r\nATTENDEE:mailto:evil@example.com\rX-INJECT:1",
    start: d("2026-11-09T07:00:00-06:00"),
    end: d("2026-11-09T08:00:00-06:00"),
  });
  const unfolded = ics.replace(/\r\n /g, "");
  assert.doesNotMatch(unfolded, /^ATTENDEE/m);
  assert.doesNotMatch(unfolded, /^X-INJECT/m);
  assert.doesNotMatch(ics, /\r(?!\n)/); // no lone carriage returns
});

test("long lines are folded at 75 octets without breaking UTF-8", () => {
  const { ics } = buildEvent({
    title: "Física ".repeat(30),
    start: d("2026-11-09T07:00:00-06:00"),
    end: d("2026-11-09T08:00:00-06:00"),
  });
  for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, line);
  const ev = Object.values(ical.sync.parseICS(ics)).find((x) => x.type === "VEVENT");
  assert.equal(ev.summary.trim(), "Física ".repeat(30).trim());
});

test("delete only accepts event URLs inside the user's own iCloud calendars", () => {
  const mine = ["https://p42-caldav.icloud.com/123/calendars/home/"];
  const good = "https://p42-caldav.icloud.com/123/calendars/home/abc.ics";
  assert.equal(assertOwnedEventUrl(good, mine), good);
  for (const bad of [
    "https://evil.example.com/123/calendars/home/abc.ics", // other host: would leak credentials
    "https://p42-caldav.icloud.com.evil.com/123/calendars/home/abc.ics", // look-alike host
    "http://p42-caldav.icloud.com/123/calendars/home/abc.ics", // not HTTPS
    "https://p42-caldav.icloud.com/123/calendars/work/abc.ics", // not one of mine
    "https://p42-caldav.icloud.com/123/calendars/home/../work/abc.ics", // path traversal
    "https://p42-caldav.icloud.com/123/calendars/home/", // the calendar itself
    "not a url",
  ]) {
    assert.throws(() => assertOwnedEventUrl(bad, mine), /Refused|Invalid/, bad);
  }
});

test("recurring event round-trips: weekdays at 12:00 local, cancelled-date aware", () => {
  const { ics } = buildEvent({
    title: "Work",
    start: d("2026-11-09T12:00:00-06:00"),
    end: d("2026-11-09T15:00:00-06:00"),
    recurrence: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
    zone: "America/Mexico_City",
  });
  assert.match(ics, /DTSTART;TZID=America\/Mexico_City:20261109T120000/);
  assert.match(ics, /BEGIN:VTIMEZONE[\s\S]*TZOFFSETTO:-0600/);
  const occ = expandEvents(ics, d("2026-11-09T00:00:00-06:00"), d("2026-11-16T00:00:00-06:00"));
  assert.equal(occ.length, 5);
  assert.ok(occ.every((o) => o.start.getUTCHours() === 18 && o.end - o.start === 3 * 3600_000));
});

test("recurrence rules that try to inject properties are rejected", () => {
  for (const bad of [
    "FREQ=WEEKLY\r\nATTENDEE:mailto:x@example.com",
    "FREQ=WEEKLY;BYDAY=MO\nX-INJECT:1",
    "BYDAY=MO", // no FREQ
    "FREQ=SECONDLY", // not allowed
  ]) {
    assert.throws(
      () => buildEvent({ title: "x", start: d("2026-11-09T12:00:00Z"), end: d("2026-11-09T13:00:00Z"), recurrence: bad }),
      /Invalid recurrence/,
      JSON.stringify(bad)
    );
  }
});
