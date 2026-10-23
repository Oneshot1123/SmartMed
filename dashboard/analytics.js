/*
 * analytics.js — adherence computation for SmartMed
 *
 * Pure functions only: no DOM, no Firebase. Input is the raw history log plus the
 * prescribed schedules; output is a computed object. Keeping this module free of side
 * effects is what makes the numbers auditable for the write-up.
 *
 * Method follows McGrady ME & Ramsey RR, "Using Electronic Monitoring Devices to Assess
 * Medication Adherence: a Research Methods Framework", J Gen Intern Med 2020;35(9):2707-14
 * (referred to as P2 throughout, and in RESEARCH_BASIS.md).
 *
 * The single most important rule from P2: adherence is computed at the DAILY level and
 * then averaged over the observation window. It is not pooled across the whole period.
 * A patient who takes 6 doses on Monday and 0 on Tuesday scores 50%, not 100%.
 */
(function (global) {
  'use strict';

  // --- Parameters (surfaced verbatim in the dashboard Methods panel) ------------------

  // P2 gives +/-60 min as the example timing window. A dose outside it counts toward
  // taking adherence but not timing adherence.
  var TIMING_WINDOW_MIN = 60;

  // P2's repeat-actuation rule: multiple actuations inside this window reflect user error
  // or device noise, not multiple doses. Here, one hand breaking the IR beam twice.
  var DEDUP_WINDOW_MIN = 30;

  // Conventional adherence cutoff, drawn as a reference line on the daily chart.
  var ADHERENCE_THRESHOLD = 80;

  // P2 allows capping daily values at 100% so over-consumption cannot inflate the mean.
  var CAP_DAILY_AT_100 = true;

  var MS_PER_DAY = 86400000;

  // --- Date helpers ------------------------------------------------------------------
  // All dates are handled in LOCAL time. P2 defines the analysis day as local midnight to
  // midnight, and `new Date("2026-01-05")` parses as UTC, which shifts days for anyone
  // east or west of Greenwich. So we always build dates from explicit components.

  function dateKey(d) {
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }

  function parseDateKey(key) {
    var p = String(key).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }

  function addDays(d, n) {
    var out = new Date(d.getTime());
    out.setDate(out.getDate() + n);
    return out;
  }

  // "HH:MM" -> minutes since local midnight. Returns null on anything unparseable.
  function timeToMinutes(t) {
    if (typeof t !== 'string') return null;
    var m = t.trim().match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    var h = +m[1], min = +m[2];
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }

  function minutesToTime(mins) {
    var h = Math.floor(mins / 60), m = mins % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  // --- Normalisation -----------------------------------------------------------------

  /*
   * Turn a raw history record into a normalised event.
   *
   * Records written before the firmware change carry only {date, time, status}. Those are
   * still usable for taking adherence; they simply have no scheduledTime, so they are
   * matched to a slot by proximity instead. They are never discarded, and never counted
   * as misses just for being old.
   */
  function normaliseEvent(key, raw) {
    if (!raw || !raw.date || !raw.status) return null;
    var mins = timeToMinutes(raw.time);
    if (mins === null) return null;

    var day = parseDateKey(raw.date);
    if (isNaN(day.getTime())) return null;

    return {
      id: key,
      dateKey: raw.date,
      minutes: mins,
      status: raw.status,
      taken: raw.status === 'Taken',
      medName: raw.medName || null,
      compartment: raw.compartment != null ? String(raw.compartment) : null,
      scheduledMinutes: timeToMinutes(raw.scheduledTime),
      delaySec: typeof raw.delaySec === 'number' ? raw.delaySec : null,
      simulated: raw.simulated === true
    };
  }

  function normaliseHistory(historyObject) {
    var out = [];
    if (!historyObject) return out;
    Object.keys(historyObject).forEach(function (k) {
      var ev = normaliseEvent(k, historyObject[k]);
      if (ev) out.push(ev);
    });
    out.sort(function (a, b) {
      if (a.dateKey !== b.dateKey) return a.dateKey < b.dateKey ? -1 : 1;
      return a.minutes - b.minutes;
    });
    return out;
  }

  /*
   * P2 repeat-actuation removal. Within a compartment (the closest thing this hardware has
   * to "one medication"), collapse events closer together than DEDUP_WINDOW_MIN, keeping
   * the FIRST — the paper's worked example keeps 8:03:10 out of 8:03:10 / 8:04:12 / 8:04:33.
   *
   * Only Taken events are collapsed. A Missed record is emitted once by the firmware at the
   * end of a monitoring window and never repeats.
   */
  function dedupeActuations(events, windowMin) {
    var win = windowMin == null ? DEDUP_WINDOW_MIN : windowMin;
    var lastByGroup = {};
    var kept = [];
    var removed = 0;

    events.forEach(function (ev) {
      if (!ev.taken) { kept.push(ev); return; }
      // Events that name their slot are only duplicates of the same slot: two schedules
      // sharing a compartment 20 min apart are two real doses, not one beam broken twice.
      var group = ev.dateKey + '|' + (ev.compartment || ev.medName || '*') +
                  (ev.scheduledMinutes !== null ? '|' + ev.scheduledMinutes : '');
      var prev = lastByGroup[group];
      if (prev != null && ev.minutes - prev <= win) { removed++; return; }
      lastByGroup[group] = ev.minutes;
      kept.push(ev);
    });

    kept.duplicatesRemoved = removed;
    return kept;
  }

  // --- Prescribed regimen (the denominator P) -----------------------------------------

  /*
   * Expand the schedule definitions into the doses due on each date in the window.
   *
   * frequency "daily" recurs every day from its start date onward, but only up to the end
   * of its prescribed course: a schedule carrying `days` (e.g. 7) stops after that many
   * days, one day per day. Schedules without `days` are ongoing and recur until deleted.
   * "once" applies only on its own date. A schedule with no usable time is skipped rather
   * than counted as a dose that could never be taken.
   */

  /*
   * Normalised course length of a schedule: a positive integer of days, or null when the
   * schedule has no finite course (ongoing) or carries a nonsensical value. Accepts numeric
   * or string values ("7") because Firebase field types are trusted on read.
   */
  function courseDays(s) {
    var d = s && s.days != null ? parseInt(s.days, 10) : NaN;
    if (isNaN(d) || d < 1) return null;
    return Math.min(365, d);
  }

  /*
   * Last day of a schedule's course as a "YYYY-MM-DD" key, or null when the schedule is
   * ongoing (no usable `days`) or a one-off. Used by the dashboard to label courses.
   */
  function scheduleEndDate(s) {
    if (!s || s.frequency === 'once') return null;
    var days = courseDays(s);
    if (s.date && days !== null) return dateKey(addDays(parseDateKey(s.date), days - 1));
    return null;
  }

  function expandPrescribed(schedules, fromKey, toKey) {
    var byDate = {};
    var from = parseDateKey(fromKey);
    var to = parseDateKey(toKey);

    for (var d = new Date(from.getTime()); d <= to; d = addDays(d, 1)) {
      byDate[dateKey(d)] = [];
    }
    if (!schedules) return byDate;

    Object.keys(schedules).forEach(function (id) {
      var s = schedules[id];
      if (!s) return;
      var mins = timeToMinutes(s.time);
      if (mins === null) return;

      var slot = {
        id: id,
        medName: s.medName || 'Unnamed',
        compartment: s.compartment != null ? String(s.compartment) : null,
        minutes: mins,
        time: minutesToTime(mins)
      };

      if (s.frequency === 'daily') {
        // Recurs from its start date. A schedule created today does not retroactively
        // make yesterday a missed dose, so days before `s.date` get nothing. A course
        // (`days`) stops after its last day; without one it runs until deleted.
        var start = s.date ? parseDateKey(s.date) : from;
        var length = courseDays(s);
        var end = length !== null ? addDays(start, length - 1) : null;
        Object.keys(byDate).forEach(function (k) {
          if (parseDateKey(k) < start) return;
          if (end !== null && parseDateKey(k) > end) return;
          byDate[k].push(slot);
        });
      } else if (s.date && byDate[s.date]) {
        byDate[s.date].push(slot);
      }
    });

    Object.keys(byDate).forEach(function (k) {
      byDate[k].sort(function (a, b) { return a.minutes - b.minutes; });
    });
    return byDate;
  }

  // --- Matching events to prescribed slots --------------------------------------------

  /*
   * Assign each day's events to that day's prescribed slots.
   *
   * Two passes, so the reliable signal wins:
   *   1. Exact — events carrying scheduledTime (post-firmware-change) bind to the slot at
   *      that time, preferring a matching compartment when both sides have one.
   *   2. Proximity — legacy events with no scheduledTime bind to the nearest still-unclaimed
   *      slot. Ambiguous by nature, which is exactly why the firmware now records the slot.
   *
   * Each slot can be claimed once. Surplus events beyond the prescribed count are returned
   * as `extra` rather than silently inflating the numerator.
   */
  function matchDay(slots, events) {
    var assignments = slots.map(function (slot) {
      return { slot: slot, event: null, onTime: false, deltaMin: null };
    });
    var extra = [];
    var pending = [];

    events.forEach(function (ev) {
      if (!ev.taken) return; // Missed records inform the heatmap, never the numerator

      if (ev.scheduledMinutes !== null) {
        var exact = -1;
        for (var i = 0; i < assignments.length; i++) {
          var a = assignments[i];
          if (a.event || a.slot.minutes !== ev.scheduledMinutes) continue;
          if (ev.compartment && a.slot.compartment && ev.compartment !== a.slot.compartment) continue;
          exact = i;
          break;
        }
        if (exact >= 0) {
          assignments[exact].event = ev;
          assignments[exact].deltaMin = ev.minutes - assignments[exact].slot.minutes;
          return;
        }
      }
      pending.push(ev);
    });

    pending.forEach(function (ev) {
      var best = -1, bestDist = Infinity;
      assignments.forEach(function (a, i) {
        if (a.event) return;
        if (ev.compartment && a.slot.compartment && ev.compartment !== a.slot.compartment) return;
        var dist = Math.abs(ev.minutes - a.slot.minutes);
        if (dist < bestDist) { bestDist = dist; best = i; }
      });
      if (best >= 0) {
        assignments[best].event = ev;
        assignments[best].deltaMin = ev.minutes - assignments[best].slot.minutes;
      } else {
        extra.push(ev);
      }
    });

    assignments.forEach(function (a) {
      a.onTime = a.event != null && Math.abs(a.deltaMin) <= TIMING_WINDOW_MIN;
    });

    return { assignments: assignments, extra: extra };
  }

  // --- The daily table (P2's core structure) -------------------------------------------

  /*
   * One row per calendar day: P (doses prescribed), N (doses taken), N_onTime, and whether
   * the day had exactly the correct dose count.
   *
   * `nonUseDates` implements P2's non-use exclusion: days of documented legitimate non-use
   * (hospitalisation, prescription held) are dropped from BOTH numerator and denominator,
   * so they do not count against the patient. This is distinct from non-adherence.
   */
  function buildDailyTable(history, schedules, fromKey, toKey, nonUseDates, nowMinutes) {
    var nonUse = nonUseDates || {};
    var events = dedupeActuations(normaliseHistory(history));
    var prescribed = expandPrescribed(schedules, fromKey, toKey);

    var eventsByDate = {};
    events.forEach(function (ev) {
      (eventsByDate[ev.dateKey] = eventsByDate[ev.dateKey] || []).push(ev);
    });

    var rows = Object.keys(prescribed).sort().map(function (key) {
      var slots = prescribed[key];
      var dayEvents = eventsByDate[key] || [];
      var matched = matchDay(slots, dayEvents);
      var assignments = matched.assignments;

      // Today's doses that are not due yet are neither taken nor missed. Keep one only if
      // it was already taken early.
      if (key === toKey && nowMinutes != null) {
        assignments = assignments.filter(function (a) {
          return a.event || a.slot.minutes <= nowMinutes;
        });
      }

      var N = 0, nOnTime = 0;
      assignments.forEach(function (a) {
        if (a.event) N++;
        if (a.onTime) nOnTime++;
      });

      var P = assignments.length;
      var excluded = nonUse[key] === true;

      return {
        date: key,
        weekday: parseDateKey(key).getDay(),
        P: P,
        N: N,
        N_onTime: nOnTime,
        extra: matched.extra.length,
        correctDay: P > 0 && N === P,
        excluded: excluded,
        assignments: assignments,
        // Daily percentages, capped per P2 so an extra dose cannot push a day above 100%.
        takingPct: P > 0 ? pct(N, P) : null,
        timingPct: P > 0 ? pct(nOnTime, P) : null
      };
    });

    rows.duplicatesRemoved = events.duplicatesRemoved || 0;
    return rows;
  }

  function pct(n, d) {
    if (!d) return null;
    var v = (n / d) * 100;
    return CAP_DAILY_AT_100 ? Math.min(v, 100) : v;
  }

  // --- Summary statistics ---------------------------------------------------------------

  /*
   * P2's three implementation-adherence statistics.
   *
   * Each is the MEAN OF THE DAILY VALUES, not the pooled total. Days with no prescribed
   * dose contribute nothing (a day off the regimen is not a 0% day), and excluded non-use
   * days are dropped entirely.
   *
   * The pooled totals are still returned as `numerator`/`denominator` because the Methods
   * panel and the academic export have to state them — but they are not what is displayed.
   */
  function summarise(rows) {
    var scored = rows.filter(function (r) { return !r.excluded && r.P > 0; });

    var takingDaily = scored.map(function (r) { return r.takingPct; });
    var timingDaily = scored.map(function (r) { return r.timingPct; });
    var correctDays = scored.filter(function (r) { return r.correctDay; }).length;

    var totalP = 0, totalN = 0, totalOnTime = 0;
    scored.forEach(function (r) { totalP += r.P; totalN += r.N; totalOnTime += r.N_onTime; });

    return {
      taking: {
        value: mean(takingDaily),
        numerator: totalN,
        denominator: totalP,
        label: 'Taking adherence',
        definition: 'Mean over days of (doses taken / doses prescribed) x 100'
      },
      timing: {
        value: mean(timingDaily),
        numerator: totalOnTime,
        denominator: totalP,
        label: 'Timing adherence',
        definition: 'Mean over days of (doses taken within +/-' + TIMING_WINDOW_MIN +
                    ' min of the scheduled time / doses prescribed) x 100'
      },
      correctDosing: {
        value: scored.length ? (correctDays / scored.length) * 100 : null,
        numerator: correctDays,
        denominator: scored.length,
        label: 'Correct-dosing days',
        definition: 'Days on which the exact prescribed number of doses was taken / days observed'
      },
      daysObserved: scored.length,
      daysExcluded: rows.filter(function (r) { return r.excluded; }).length,
      daysWithoutRegimen: rows.filter(function (r) { return !r.excluded && r.P === 0; }).length,
      duplicatesRemoved: rows.duplicatesRemoved || 0,
      totalPrescribed: totalP,
      totalTaken: totalN,
      totalMissed: totalP - totalN,
      extraDoses: scored.reduce(function (s, r) { return s + r.extra; }, 0)
    };
  }

  function mean(values) {
    var clean = values.filter(function (v) { return typeof v === 'number' && !isNaN(v); });
    if (!clean.length) return null;
    return clean.reduce(function (a, b) { return a + b; }, 0) / clean.length;
  }

  function median(values) {
    if (!values.length) return null;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // --- Pattern analysis: miss rate by hour of day x weekday -----------------------------

  /*
   * A 7 x 24 grid of miss rate, keyed by (weekday of the dose, hour the dose was DUE).
   *
   * Bucketing by scheduled hour rather than the hour a dose was actually taken is what
   * makes the grid readable: it asks "which slots get missed", not "when do people
   * happen to open the box".
   *
   * These are the patterns Burnier (Front Pharmacol 2018;9:1540) describes electronic
   * monitoring as uniquely able to reveal — the weekend effect and time-of-day drift.
   * `total` is returned per cell so the UI can de-emphasise cells with tiny samples,
   * where a single miss would otherwise read as 100%.
   */
  function missByHourWeekday(rows) {
    var grid = [];
    for (var w = 0; w < 7; w++) {
      grid.push([]);
      for (var h = 0; h < 24; h++) grid[w].push({ total: 0, missed: 0, rate: null });
    }

    rows.forEach(function (row) {
      if (row.excluded) return;
      row.assignments.forEach(function (a) {
        var hour = Math.floor(a.slot.minutes / 60);
        var cell = grid[row.weekday][hour];
        cell.total++;
        if (!a.event) cell.missed++;
      });
    });

    var maxRate = 0;
    grid.forEach(function (week) {
      week.forEach(function (cell) {
        if (cell.total > 0) {
          cell.rate = (cell.missed / cell.total) * 100;
          if (cell.rate > maxRate) maxRate = cell.rate;
        }
      });
    });

    // Which hours are actually in use, so the UI can drop 24 columns down to the few
    // that carry doses.
    var activeHours = [];
    for (var h2 = 0; h2 < 24; h2++) {
      for (var w2 = 0; w2 < 7; w2++) {
        if (grid[w2][h2].total > 0) { activeHours.push(h2); break; }
      }
    }

    return { grid: grid, activeHours: activeHours, maxRate: maxRate };
  }

  // --- Lateness ------------------------------------------------------------------------

  // Median lateness of the doses that were actually taken. Reported alongside timing
  // adherence to say *how* late, not just how often.
  function latenessStats(rows) {
    var deltas = [];
    rows.forEach(function (row) {
      if (row.excluded) return;
      row.assignments.forEach(function (a) {
        if (a.event && a.deltaMin !== null) deltas.push(a.deltaMin);
      });
    });
    if (!deltas.length) return { count: 0, median: null, earliest: null, latest: null };

    var sorted = deltas.slice().sort(function (a, b) { return a - b; });
    return {
      count: sorted.length,
      median: median(deltas),
      earliest: sorted[0],
      latest: sorted[sorted.length - 1]
    };
  }

  // --- Top-level entry point -------------------------------------------------------------

  /*
   * Compute everything for a window ending today.
   * Returns null-valued metrics rather than NaN when there is nothing to score, so the UI
   * can show an honest empty state instead of a broken number.
   */
  function analyse(history, schedules, windowDays, options) {
    var opts = options || {};
    var end = opts.today ? parseDateKey(opts.today) : new Date();
    var start = addDays(end, -(windowDays - 1));
    var fromKey = dateKey(start), toKey = dateKey(end);

    // Where "today" stops. Defaults to the clock for a live window; a fixed `today` (tests,
    // historic reports) scores the whole day unless `nowMinutes` is given.
    var nowMinutes = opts.nowMinutes != null ? opts.nowMinutes
      : (opts.today ? null : end.getHours() * 60 + end.getMinutes());

    var rows = buildDailyTable(history, schedules, fromKey, toKey, opts.nonUseDates, nowMinutes);

    return {
      window: { days: windowDays, from: fromKey, to: toKey },
      rows: rows,
      summary: summarise(rows),
      heatmap: missByHourWeekday(rows),
      lateness: latenessStats(rows),
      params: {
        timingWindowMin: TIMING_WINDOW_MIN,
        dedupWindowMin: DEDUP_WINDOW_MIN,
        threshold: ADHERENCE_THRESHOLD,
        cappedAt100: CAP_DAILY_AT_100
      }
    };
  }

  // --- Academic export -------------------------------------------------------------------

  // The daily table as CSV. Every headline percentage on the dashboard is re-derivable
  // from these rows by hand, which is the point of exporting it.
  function toCSV(result) {
    var lines = [];
    lines.push('# SmartMed adherence export');
    lines.push('# Observation window,' + result.window.from + ' to ' + result.window.to +
               ' (' + result.window.days + ' days)');
    lines.push('# Timing window,+/-' + result.params.timingWindowMin + ' min');
    lines.push('# Repeat-actuation window,' + result.params.dedupWindowMin + ' min');
    lines.push('# Method,McGrady & Ramsey 2020 (J Gen Intern Med 35:2707-14) - daily values then averaged');
    lines.push('');
    lines.push('date,weekday,prescribed_P,taken_N,on_time_N,extra_doses,correct_day,excluded_non_use,taking_pct,timing_pct');

    result.rows.forEach(function (r) {
      lines.push([
        r.date,
        ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][r.weekday],
        r.P, r.N, r.N_onTime, r.extra,
        r.correctDay ? 'yes' : 'no',
        r.excluded ? 'yes' : 'no',
        r.takingPct === null ? '' : r.takingPct.toFixed(2),
        r.timingPct === null ? '' : r.timingPct.toFixed(2)
      ].join(','));
    });

    var s = result.summary;
    lines.push('');
    lines.push('# Summary (mean of daily values)');
    lines.push('metric,value_pct,numerator,denominator');
    ['taking', 'timing', 'correctDosing'].forEach(function (k) {
      var m = s[k];
      lines.push([m.label, m.value === null ? '' : m.value.toFixed(2), m.numerator, m.denominator].join(','));
    });
    lines.push('days observed,' + s.daysObserved);
    lines.push('days excluded (non-use),' + s.daysExcluded);
    lines.push('repeat actuations removed,' + s.duplicatesRemoved);

    return lines.join('\n');
  }

  global.SmedAnalytics = {
    analyse: analyse,
    buildDailyTable: buildDailyTable,
    summarise: summarise,
    missByHourWeekday: missByHourWeekday,
    latenessStats: latenessStats,
    expandPrescribed: expandPrescribed,
    courseDays: courseDays,
    scheduleEndDate: scheduleEndDate,
    dedupeActuations: dedupeActuations,
    normaliseHistory: normaliseHistory,
    toCSV: toCSV,
    dateKey: dateKey,
    parseDateKey: parseDateKey,
    addDays: addDays,
    timeToMinutes: timeToMinutes,
    minutesToTime: minutesToTime,
    mean: mean,
    median: median,
    TIMING_WINDOW_MIN: TIMING_WINDOW_MIN,
    DEDUP_WINDOW_MIN: DEDUP_WINDOW_MIN,
    ADHERENCE_THRESHOLD: ADHERENCE_THRESHOLD
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.SmedAnalytics;
})(typeof window !== 'undefined' ? window : globalThis);
