// Pickup/delivery time slots in India time. Pure functions.
import { addDays, fromMinutes, istParts, toMinutes } from "./util.js";

const weekdayOf = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay();

// Every slot customers may choose, grouped by day: [{ date, times: ["11:00", ...] }]
export function slotDays(settings, needsNotice, now = new Date()) {
  const today = istParts(now);
  const first = needsNotice ? settings.preorderNoticeDays : 0;
  const open = toMinutes(settings.openTime);
  const close = toMinutes(settings.closeTime);
  const days = [];
  for (let d = first; d <= Math.max(first, settings.maxDaysAhead); d++) {
    const date = addDays(today.date, d);
    if (settings.closedDays.includes(weekdayOf(date))) continue;
    const earliest = date === today.date ? today.minutes + settings.prepMinutes : 0;
    const times = [];
    for (let m = open; m < close; m += settings.slotMinutes) if (m >= earliest) times.push(fromMinutes(m));
    if (times.length) days.push({ date, times });
  }
  return days;
}

export function checkSlot(date, time, settings, needsNotice, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !/^\d{2}:\d{2}$/.test(String(time))) return { error: "Please choose a day and time" };
  const day = slotDays(settings, needsNotice, now).find((d) => d.date === date);
  if (!day) {
    return { error: needsNotice ? `Cakes need ${settings.preorderNoticeDays} days' notice. Please pick a later day.` : "We're not taking orders for that day" };
  }
  if (!day.times.includes(time)) return { error: "That time isn't available any more. Please pick another." };
  return { value: { date, time } };
}

export const needsNotice = (lines, settings) => lines.some((l) => settings.preorderCategories.includes(l.category));
