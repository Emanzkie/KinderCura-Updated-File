// js/shared/child-age.js
// ============================================================================
// The one child-eligibility rule for registration: a child may be registered
// only when they are at least 3 and at most 8 years old (completed years,
// counted from the full date of birth, so a child who turns 3 next month is
// still 2 today and a child who is 8 years 11 months old is still 8).
//
// Shared by the sign-up page (window.KCChildAge, loaded before
// js/auth/signup.js) and the server (require('../js/shared/child-age')), so the
// browser and routes/auth.js + routes/children.js can never disagree.
//
// Dates are handled as plain calendar dates ({ year, month, day }), never as
// Date objects: "2023-10-09" from <input type="date"> parsed with new Date()
// is UTC midnight, which is the previous day anywhere west of UTC. "Today" is
// the caller's calendar date — the browser's local date, or on the server the
// date in the clinic's time zone (todayInTimeZone).
//
// Feb 29 birthdays: in a non-leap year the child gains the year on Mar 1.
// ============================================================================

(function (global) {
  'use strict';

  const MIN_AGE_YEARS = 3;
  const MAX_AGE_YEARS = 8;
  // The server has no browser clock to ask, and on Vercel it runs in UTC, which
  // is still "yesterday" for the first 8 hours of a Philippine day. Without this
  // a child whose 3rd birthday is today would pass the page and fail the server.
  const CLINIC_TIME_ZONE = 'Asia/Manila';

  const TITLE = 'Age Requirement Not Met';
  const MESSAGES = Object.freeze({
    too_young: 'Your child is below the eligible age range. KinderCura registration is only available for children aged 3 to 8 years old.',
    too_old: 'Your child is above the eligible age range. KinderCura registration is only available for children aged 3 to 8 years old.',
    missing: 'Please enter a valid date of birth before continuing.',
    invalid: 'Please enter a valid date of birth before continuing.',
    future: 'Please enter a valid date of birth before continuing. The date of birth cannot be in the future.',
  });

  function isLeapYear(year) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  }

  function daysInMonth(year, month) {
    return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  }

  // "YYYY-MM-DD" -> { year, month, day }, or null when it is not a real date
  // (wrong shape, month 13, Feb 30, Feb 29 in a non-leap year, ...).
  function parseDateOnly(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value == null ? '' : value).trim());
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
    return { year, month, day };
  }

  function compareDates(a, b) {
    return (a.year - b.year) || (a.month - b.month) || (a.day - b.day);
  }

  function formatDateOnly(date) {
    const pad = (n, width) => String(n).padStart(width, '0');
    return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
  }

  // The browser's (or Node process's) own calendar date.
  function localToday(now) {
    const d = now instanceof Date ? now : new Date();
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  }

  // The calendar date in an IANA time zone, e.g. 'Asia/Manila'.
  function todayInTimeZone(timeZone, now) {
    const d = now instanceof Date ? now : new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: 'numeric', day: 'numeric',
    }).formatToParts(d);
    const pick = (type) => Number(parts.find((p) => p.type === type).value);
    return { year: pick('year'), month: pick('month'), day: pick('day') };
  }

  // Completed years between two calendar dates.
  function ageInYears(birth, today) {
    let age = today.year - birth.year;
    if (today.month < birth.month || (today.month === birth.month && today.day < birth.day)) age -= 1;
    return age;
  }

  // The same calendar date `years` earlier, with Feb 29 falling back to Feb 28.
  function yearsBefore(date, years) {
    const year = date.year - years;
    return { year, month: date.month, day: Math.min(date.day, daysInMonth(year, date.month)) };
  }

  function nextDay(date) {
    if (date.day < daysInMonth(date.year, date.month)) return { ...date, day: date.day + 1 };
    if (date.month < 12) return { year: date.year, month: date.month + 1, day: 1 };
    return { year: date.year + 1, month: 1, day: 1 };
  }

  // The range of birth dates that are eligible today, as "YYYY-MM-DD" strings
  // for the date input's min/max. The picker is only a convenience: the
  // Continue button and the server still run checkChildAge.
  function eligibleBirthDateRange(today) {
    return {
      // Born on this day or earlier: already had their 3rd birthday.
      max: formatDateOnly(yearsBefore(today, MIN_AGE_YEARS)),
      // Born after this day 9 years ago: has not had their 9th birthday yet.
      min: formatDateOnly(nextDay(yearsBefore(today, MAX_AGE_YEARS + 1))),
    };
  }

  // { ok: true, age } or { ok: false, reason, title, message, age? }.
  // reason: 'missing' | 'invalid' | 'future' | 'too_young' | 'too_old'.
  function checkChildAge(value, today) {
    const now = today || localToday();
    const fail = (reason, age) => ({
      ok: false,
      reason,
      age: age == null ? null : age,
      title: TITLE,
      message: MESSAGES[reason],
    });

    if (!String(value == null ? '' : value).trim()) return fail('missing');
    const birth = parseDateOnly(value);
    if (!birth) return fail('invalid');
    if (compareDates(birth, now) > 0) return fail('future');

    const age = ageInYears(birth, now);
    if (age < MIN_AGE_YEARS) return fail('too_young', age);
    if (age > MAX_AGE_YEARS) return fail('too_old', age);
    return { ok: true, age };
  }

  const api = Object.freeze({
    MIN_AGE_YEARS,
    MAX_AGE_YEARS,
    CLINIC_TIME_ZONE,
    TITLE,
    MESSAGES,
    parseDateOnly,
    formatDateOnly,
    localToday,
    todayInTimeZone,
    ageInYears,
    eligibleBirthDateRange,
    checkChildAge,
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.KCChildAge = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
