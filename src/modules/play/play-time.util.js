const { AppError } = require('../../utils/error-response');

// Timezone arithmetic for the Playlog calendar and the Monthly Replay.
//
// Everything is stored in UTC. A "month" or a "day" is a *local* window, so the
// boundaries are computed by inverting the zone offset at the candidate instant
// instead of adding a fixed number of hours. That makes the windows correct
// across DST transitions, including the 23-hour and 25-hour local days that a
// naive `+offset` calculation silently gets wrong.

const OFFSET_PARTS_FORMATTER_CACHE = new Map();

function getOffsetFormatter(timeZone) {
  let formatter = OFFSET_PARTS_FORMATTER_CACHE.get(timeZone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    OFFSET_PARTS_FORMATTER_CACHE.set(timeZone, formatter);
  }

  return formatter;
}

function assertSupportedTimeZone(timeZone) {
  try {
    getOffsetFormatter(timeZone).format(new Date(0));
  } catch (error) {
    throw new AppError(400, 'INVALID_TIMEZONE', 'The supplied timezone is not a supported IANA identifier', [{
      field: 'timezone',
      message: String(timeZone).slice(0, 64)
    }]);
  }

  return timeZone;
}

function readZonedParts(instant, timeZone) {
  const parts = getOffsetFormatter(timeZone).formatToParts(instant);
  const values = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      values[part.type] = Number(part.value);
    }
  }

  // Intl renders midnight as hour 24 in some engines/locales; normalize it.
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour % 24,
    minute: values.minute,
    second: values.second
  };
}

/// Offset in milliseconds that must be subtracted from a local wall time to get
/// the UTC instant (i.e. `utc = local - offset`).
function getZoneOffsetMs(instant, timeZone) {
  const parts = readZonedParts(instant, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);

  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/// Converts a local wall-clock time in `timeZone` to the corresponding UTC
/// instant. Two refinement passes converge across DST because the offset is
/// re-read at the candidate instant.
function zonedWallTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let instant = new Date(localAsUtc);

  for (let pass = 0; pass < 3; pass += 1) {
    const offset = getZoneOffsetMs(instant, timeZone);
    const next = new Date(localAsUtc - offset);

    if (next.getTime() === instant.getTime()) {
      return instant;
    }

    instant = next;
  }

  return instant;
}

/// Local calendar date (YYYY-MM-DD) of a UTC instant in `timeZone`.
function toZonedDateKey(instant, timeZone) {
  const parts = readZonedParts(instant instanceof Date ? instant : new Date(instant), timeZone);

  return [
    String(parts.year).padStart(4, '0'),
    String(parts.month).padStart(2, '0'),
    String(parts.day).padStart(2, '0')
  ].join('-');
}

function parseMonthKey(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(month ?? ''));

  if (!match) {
    throw new AppError(400, 'INVALID_MONTH', 'month must be formatted as YYYY-MM');
  }

  const year = Number(match[1]);
  const monthNumber = Number(match[2]);

  if (year < 1970 || year > 9999 || monthNumber < 1 || monthNumber > 12) {
    throw new AppError(400, 'INVALID_MONTH', 'month must be a real calendar month formatted as YYYY-MM');
  }

  return { year, month: monthNumber };
}

/// Half-open UTC window `[startUtc, endUtc)` covering the local month. The end is
/// local midnight of the first day of the next month, so a DST shift inside the
/// month cannot drop or duplicate an hour.
function resolveMonthWindow({ month, timeZone }) {
  assertSupportedTimeZone(timeZone);

  const { year, month: monthNumber } = parseMonthKey(month);
  const nextMonthYear = monthNumber === 12 ? year + 1 : year;
  const nextMonthNumber = monthNumber === 12 ? 1 : monthNumber + 1;

  return {
    monthKey: `${String(year).padStart(4, '0')}-${String(monthNumber).padStart(2, '0')}`,
    startUtc: zonedWallTimeToUtc({ year, month: monthNumber, day: 1 }, timeZone),
    endUtc: zonedWallTimeToUtc({ year: nextMonthYear, month: nextMonthNumber, day: 1 }, timeZone),
    timeZone
  };
}

/// Every local calendar date in the window, in order. Length reflects the real
/// number of local days in the month.
function listMonthDateKeys({ month, timeZone }) {
  const { year, month: monthNumber } = parseMonthKey(month);
  const dayCount = new Date(Date.UTC(monthNumber === 12 ? year + 1 : year, monthNumber % 12, 1)).getTime();
  const firstOfMonth = Date.UTC(year, monthNumber - 1, 1);
  const days = Math.round((dayCount - firstOfMonth) / 86_400_000);
  const keys = [];

  for (let day = 1; day <= days; day += 1) {
    keys.push([
      String(year).padStart(4, '0'),
      String(monthNumber).padStart(2, '0'),
      String(day).padStart(2, '0')
    ].join('-'));
  }

  return keys;
}

module.exports = {
  assertSupportedTimeZone,
  getZoneOffsetMs,
  listMonthDateKeys,
  parseMonthKey,
  resolveMonthWindow,
  toZonedDateKey,
  zonedWallTimeToUtc
};
