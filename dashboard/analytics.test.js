/*
 * analytics.test.js — hand-worked fixture for the adherence computations.
 *
 * Run with:  node dashboard/analytics.test.js
 *
 * Every expected value below is derived by hand in the comments so the test doubles as a
 * worked example of the P2 method for the write-up.
 */
var A = require('./analytics.js');

var failures = 0;
function check(label, actual, expected, tol) {
  var ok;
  if (typeof expected === 'number' && typeof actual === 'number') {
    ok = Math.abs(actual - expected) <= (tol == null ? 0.01 : tol);
  } else {
    ok = actual === expected;
  }
  if (ok) {
    console.log('  ok   ' + label + '  =  ' + actual);
  } else {
    failures++;
    console.log('  FAIL ' + label + '  expected ' + expected + ', got ' + actual);
  }
}

/* ---------------------------------------------------------------------------
 * Fixture
 *
 * Window: 2026-03-02 (Mon) .. 2026-03-08 (Sun), 7 days.
 * Regimen: three daily doses (08:00 c1, 14:00 c2, 20:00 c3) from 2026-03-01,
 *          plus ONE extra one-off dose at 12:00 on 2026-03-06.
 *
 * Per-day expectation:
 *   03-02 Mon  P=3  taken 3 on time                        -> 100.0 / 100.0  correct
 *   03-03 Tue  P=3  08:00 logged TWICE 5 min apart (dedup)
 *                   -> 2 doses, 20:00 missed               ->  66.7 /  66.7
 *   03-04 Wed  P=3  08:00 dose taken at 09:35 (95 min late)
 *                   -> counts for taking, not for timing   -> 100.0 /  66.7  correct
 *   03-05 Thu  P=3  documented non-use -> EXCLUDED entirely (not a 0% day)
 *   03-06 Fri  P=4  nothing taken                          ->   0.0 /   0.0
 *   03-07 Sat  P=3  three legacy events (no scheduledTime)
 *                   matched by proximity                   -> 100.0 / 100.0  correct
 *   03-08 Sun  P=3  two taken on time, 20:00 missed        ->  66.7 /  66.7
 *
 * Taking  = mean(100, 66.667, 100, 0, 100, 66.667) / 6 = 72.222
 * Timing  = mean(100, 66.667, 66.667, 0, 100, 66.667) / 6 = 66.667
 * Correct = 3 of 6 scored days = 50.0
 *
 * Note the denominators differ per day (03-06 has P=4), so the POOLED figure would be
 * 13/19 = 68.42% — deliberately different from the 72.22% daily mean. If this test ever
 * reports 68.42 it means someone reintroduced pooling, which P2 explicitly rules out.
 * ------------------------------------------------------------------------- */

var schedules = {
  s1: { medName: 'Metformin',  time: '08:00', compartment: 1, date: '2026-03-01', frequency: 'daily' },
  s2: { medName: 'Amlodipine', time: '14:00', compartment: 2, date: '2026-03-01', frequency: 'daily' },
  s3: { medName: 'Atorvastatin', time: '20:00', compartment: 3, date: '2026-03-01', frequency: 'daily' },
  s4: { medName: 'Vitamin D',  time: '12:00', compartment: 1, date: '2026-03-06', frequency: 'once' }
};

function ev(date, time, status, schedTime, comp) {
  var o = { date: date, time: time, status: status };
  if (schedTime) o.scheduledTime = schedTime;
  if (comp) o.compartment = comp;
  return o;
}

var history = {
  // 03-02 — a clean day
  e01: ev('2026-03-02', '08:05', 'Taken', '08:00', 1),
  e02: ev('2026-03-02', '14:00', 'Taken', '14:00', 2),
  e03: ev('2026-03-02', '20:10', 'Taken', '20:00', 3),

  // 03-03 — IR beam broken twice for one dose, 5 min apart. P2: collapse to the FIRST.
  e04: ev('2026-03-03', '08:02', 'Taken', '08:00', 1),
  e05: ev('2026-03-03', '08:07', 'Taken', '08:00', 1),
  e06: ev('2026-03-03', '14:00', 'Taken', '14:00', 2),
  e07: ev('2026-03-03', '20:00', 'Missed', '20:00', 3),

  // 03-04 — the morning dose is 95 min late
  e08: ev('2026-03-04', '09:35', 'Taken', '08:00', 1),
  e09: ev('2026-03-04', '14:00', 'Taken', '14:00', 2),
  e10: ev('2026-03-04', '20:00', 'Taken', '20:00', 3),

  // 03-05 — non-use day, no events at all

  // 03-06 — nothing taken (P=4 that day)

  // 03-07 — legacy records: no scheduledTime, no compartment. Matched by proximity.
  e11: ev('2026-03-07', '08:00', 'Taken'),
  e12: ev('2026-03-07', '14:00', 'Taken'),
  e13: ev('2026-03-07', '20:00', 'Taken'),

  // 03-08 — evening dose missed
  e14: ev('2026-03-08', '08:00', 'Taken', '08:00', 1),
  e15: ev('2026-03-08', '14:00', 'Taken', '14:00', 2),
  e16: ev('2026-03-08', '20:00', 'Missed', '20:00', 3)
};

var result = A.analyse(history, schedules, 7, {
  today: '2026-03-08',
  nonUseDates: { '2026-03-05': true }
});

var s = result.summary;

console.log('\nWindow ' + result.window.from + ' .. ' + result.window.to);

console.log('\nDaily table:');
result.rows.forEach(function (r) {
  console.log('  ' + r.date + '  P=' + r.P + ' N=' + r.N + ' onTime=' + r.N_onTime +
    (r.excluded ? '  [EXCLUDED non-use]' : '') +
    (r.correctDay ? '  correct' : ''));
});

console.log('\nAssertions:');

// --- Structure
check('window days', result.rows.length, 7);
check('P on 03-02', result.rows[0].P, 3);
check('P on 03-06 (extra one-off dose)', result.rows[4].P, 4);
check('total prescribed across scored days', s.totalPrescribed, 19);

// --- P2 repeat-actuation rule
check('repeat actuations removed', s.duplicatesRemoved, 1);
check('N on 03-03 after dedup', result.rows[1].N, 2);

// --- P2 non-use exclusion: dropped from BOTH numerator and denominator
check('days excluded', s.daysExcluded, 1);
check('days scored', s.daysObserved, 6);
check('03-05 marked excluded', result.rows[3].excluded, true);

// --- The 95-min-late dose counts for taking but not timing
check('N on 03-04', result.rows[2].N, 3);
check('on-time N on 03-04', result.rows[2].N_onTime, 2);

// --- Legacy events with no scheduledTime still match by proximity
check('N on 03-07 (legacy events)', result.rows[5].N, 3);
check('on-time N on 03-07', result.rows[5].N_onTime, 3);

// --- The three headline statistics, as means of daily values
check('taking adherence', s.taking.value, 72.222);
check('timing adherence', s.timing.value, 66.667);
check('correct-dosing days', s.correctDosing.value, 50.0);

// --- Guard against a regression to pooled arithmetic
var pooled = (s.totalTaken / s.totalPrescribed) * 100;
check('pooled figure differs from daily mean (proves no pooling)',
  Math.abs(pooled - s.taking.value) > 1, true);

// --- P4 ordering invariant: timing can never exceed taking
check('timing <= taking', s.timing.value <= s.taking.value, true);

// --- Lateness
check('lateness sample count', result.lateness.count, 13);
check('median lateness (min)', result.lateness.median, 0);
check('latest dose (min)', result.lateness.latest, 95);

// --- Heatmap: the 20:00 slot on Sunday 03-08 was missed
check('heatmap Sun 20:00 total', result.heatmap.grid[0][20].total, 1);
check('heatmap Sun 20:00 miss rate', result.heatmap.grid[0][20].rate, 100);
check('active hours', result.heatmap.activeHours.join(','), '8,12,14,20');

// --- Empty-state behaviour: no regimen at all must yield nulls, never NaN
var empty = A.analyse({}, {}, 7, { today: '2026-03-08' });
check('empty: taking is null not NaN', empty.summary.taking.value, null);
check('empty: days observed', empty.summary.daysObserved, 0);

// --- CSV export re-derives the same numbers
var csv = A.toCSV(result);
check('csv has a row per day', csv.split('\n').filter(function (l) {
  return /^2026-03-/.test(l);
}).length, 7);

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'All assertions passed.') + '\n');
process.exit(failures ? 1 : 0);
