import test from "node:test";
import assert from "node:assert/strict";
import { notificationDue, normalizeNotificationPrefs, normalizeFilmJournal, normalizePlannerPrefs, calendarFile, selectSessions } from "../docs/planner-model.mjs";

test("quiet hours cross midnight in Beijing; urgency and digest are independent", () => {
  const at = Date.parse("2030-09-20T23:30:00+08:00") / 1000;
  const event = { kind: "release", created_at: at };
  const prefs = { quietEnabled: true, quietFrom: "23:00", quietUntil: "08:00", digestMinutes: 30 };
  const morning = Date.parse("2030-09-21T08:00:00+08:00") / 1000;
  assert.equal(notificationDue(event, {}, prefs, at).due, morning);
  assert.equal(notificationDue(event, { priority: "urgent" }, prefs, at).due, morning);
  assert.equal(notificationDue(event, { priority: "urgent" }, { ...prefs, urgentBypassQuiet: true }, at).due, at);
  assert.equal(notificationDue(event, {}, { digestMinutes: 15 }, at).due, at + 900);
  assert.equal(notificationDue({ ...event, created_at: at + 60 }, {}, { digestMinutes: 15 }, at + 60).due, at + 900);
  assert.equal(notificationDue(event, {}, prefs, morning).due, at + 1800);
  const early = Date.parse("2030-09-21T01:00:00+08:00") / 1000;
  assert.equal(notificationDue({ ...event, created_at: early }, {}, prefs, early).due, morning);
  assert.throws(() => normalizeNotificationPrefs({ quietEnabled: true, quietFrom: "08:00", quietUntil: "08:00" }));
  assert.throws(() => normalizeNotificationPrefs({ digestMinutes: 3 }));
  assert.throws(() => normalizePlannerPrefs({ defaultRuleTemplateId: "missing" }));
});
test("calendar files escape injected lines, fold UTF-8 safely and use stable event IDs and UTC", () => {
  const entry = { id: "booking-1", type: "booked", startsAt: "2030-09-20T23:30:00+08:00", durationMinutes: 120, reminderMinutes: 30, cinemaName: "影院,分店;测试", hall: "IMAX" };
  const text = calendarFile({ id: "111", name: "很长的中文电影名称".repeat(20) + "\nBEGIN:VEVENT" }, entry, { address: "西安" }, 0);
  assert.match(text, /DTSTART:20300920T153000Z/);
  assert.match(text, /DTEND:20300920T173000Z/);
  assert.match(text, /UID:booking-1@polaris-cinema/);
  assert.match(text, /TRIGGER:-PT30M/);
  assert.equal(text.split("\r\n").filter((l) => l === "BEGIN:VEVENT").length, 1);
  assert.ok(text.split("\r\n").every((l) => Buffer.byteLength(l) <= 75));
  assert.ok(text.includes("\\,分店\\;测试"));
});
test("journal validation rejects duplicate IDs, future watched dates and excessive tags", () => {
  const entry = { id: "one", type: "watched", startsAt: "2020-01-01T19:00:00+08:00", durationMinutes: 120, reminderMinutes: 0 };
  assert.equal(normalizeFilmJournal({ 111: { tags: ["IMAX", "IMAX"], review: "短评", entries: [entry] } })[111].tags.length, 1);
  assert.throws(() => normalizeFilmJournal({ 111: { entries: [entry, entry] } }));
  assert.throws(() => normalizeFilmJournal({ 111: { entries: [{ ...entry, startsAt: "2099-01-01T19:00:00+08:00" }] } }));
  assert.throws(() => normalizeFilmJournal({ 111: { tags: Array(13).fill("标签") } }));
});
test("session overview filters times, weekends, stars and actual reminder rules", () => {
  const at = Date.parse("2030-09-20T12:00:00+08:00"); // Friday.
  const data = { movies: [{ id: "111", active: true }, { id: "222" }], movieRules: { 111: { timeFrom: "19:00", formats: ["IMAX"] } }, sessions: [
    { id: "a", movie_id: "111", cinema_id: "25769", starts_at: "2030-09-21T19:30:00+08:00", available: true, hall: "IMAX", format: "3D" },
    { id: "b", movie_id: "111", cinema_id: "25769", starts_at: "2030-09-21T12:00:00+08:00", available: true, hall: "IMAX", format: "3D" },
    { id: "c", movie_id: "222", cinema_id: "39869", starts_at: "2030-09-20T19:00:00+08:00", available: true, hall: "普通厅", format: "2D" },
  ] };
  assert.deepEqual(selectSessions(data, { day: "weekend", matching: true, starred: true }, at).map((r) => r.id), ["a"]);
  assert.deepEqual(selectSessions(data, { day: "today" }, at).map((r) => r.id), ["c"]);
  assert.equal(selectSessions(data, { cinema: "39869", format: "IMAX" }, at).length, 0);
});
