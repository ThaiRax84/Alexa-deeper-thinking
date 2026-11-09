import { test } from "node:test";
import assert from "node:assert/strict";
import { connectCalendar, CalendarPool, ToolHub } from "../src/index.js";

test("connects to the calendar MCP server and marks delete_event as destructive", async () => {
  // listTools needs no iCloud access, so fake credentials are enough here.
  const client = await connectCalendar({ username: "a@b.c", appPassword: "x", timezone: "America/Mexico_City" });
  try {
    const tools = await new ToolHub().addMcp(client);
    assert.deepEqual(
      tools.specs().map((t) => t.name).sort(),
      ["add_event", "delete_event", "find_free_slots", "list_calendars", "list_events"]
    );
    assert.equal(tools.needsConfirmation("delete_event"), true);
    assert.equal(tools.needsConfirmation("add_event"), false);
  } finally {
    await client.close();
  }
});

test("the pool reuses a user's connection and reconnects when credentials change", async () => {
  let connects = 0;
  const pool = new CalendarPool({ connect: async () => ({ id: ++connects, close: async () => {} }) });
  const creds = { username: "a", appPassword: "p", timezone: "America/Mexico_City" };
  const a = await pool.get("user-1", creds);
  const b = await pool.get("user-1", creds);
  const c = await pool.get("user-1", { ...creds, appPassword: "q" });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(connects, 2);
});

test("idle connections are closed", async () => {
  let t = 0;
  let closed = 0;
  const pool = new CalendarPool({
    now: () => t,
    idleMs: 10,
    connect: async () => ({ close: async () => closed++ }),
  });
  const creds = { username: "a", appPassword: "p", timezone: "UTC" };
  await pool.get("u1", creds);
  t = 100;
  await pool.get("u2", creds);
  await new Promise((r) => setImmediate(r));
  assert.equal(closed, 1);
  assert.equal(pool.entries.has("u1"), false);
});
