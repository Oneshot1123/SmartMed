/*
 * ml-risk.test.js — verification for the browser ML inference layer.
 *
 * Run with:  node dashboard/ml-risk.test.js
 *
 * The parity fixture is produced by: python ml/features.py (see ml/data/parity_fixture.json).
 * It asserts that the Python training features and the JavaScript inference features are
 * identical, which is the main correctness risk in a train-offline/infer-in-browser design.
 */
var fs = require('fs');
var path = require('path');
var A = require('./analytics.js');
require('./ml-model.js');
var R = require('./ml-risk.js');

var failures = 0;
function check(label, actual, expected, tol) {
  var ok;
  if (typeof expected === 'number' && typeof actual === 'number') {
    ok = Math.abs(actual - expected) <= (tol == null ? 1e-9 : tol);
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

var fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ml', 'data', 'parity_fixture.json'), 'utf8'));

console.log('\nFeature parity (Python training vs JavaScript inference):');
fixture.expected.forEach(function (target) {
  var features = R._featuresAt(fixture.history, fixture.schedules, target.date, target.minutes);
  check('features exist for ' + target.date + ' ' + target.minutes, features != null, true);

  Object.keys(target.features).forEach(function (name) {
    check('  ' + name, features[name], target.features[name], 1e-9);
  });

  var day = A.buildDailyTable(fixture.history, fixture.schedules, target.date, target.date, null, null)[0];
  var assignment = day.assignments.filter(function (a) { return a.slot.minutes === target.minutes; })[0];
  var label = !assignment.event || Math.abs(assignment.deltaMin) > 60 ? 1 : 0;
  check('  label', label, target.label);
});

console.log('\nLeakage guard (target-day events must not change prior features):');
var before = R._featuresAt(fixture.history, fixture.schedules, '2026-03-08', 8 * 60);
var leakyHistory = JSON.parse(JSON.stringify(fixture.history));
leakyHistory.leak = { date: '2026-03-08', time: '08:05', status: 'Taken', scheduledTime: '08:00', compartment: 1 };
var after = R._featuresAt(leakyHistory, fixture.schedules, '2026-03-08', 8 * 60);
check('features unchanged by target-day event', JSON.stringify(before) === JSON.stringify(after), true);

console.log('\nScoring:');
check('sigmoid(0)', R.sigmoid(0), 0.5);
var scored = R._scoreFeatures(before);
check('probability in [0,1]', scored.probability >= 0 && scored.probability <= 1, true);
check('risk level is valid', ['low', 'medium', 'high'].indexOf(scored.level) >= 0, true);
check('at most two reasons', scored.reasons.length <= 2, true);
check('model loaded', R.modelInfo() != null, true);
check('model feature count', R.modelInfo() && require('./ml-model.js').features.length, Object.keys(before).length);

console.log('\nUpcoming dose ranking:');
var upcoming = R.scoreUpcoming(fixture.history, fixture.schedules, {
  today: '2026-03-08',
  nowMinutes: 0,
  daysAhead: 1
});
check('upcoming doses found', upcoming.upcoming.length > 0, true);
check('upcoming probabilities bounded', upcoming.upcoming.every(function (d) {
  return d.probability >= 0 && d.probability <= 1;
}), true);
check('top list sorted descending', upcoming.top.every(function (d, i, list) {
  return i === 0 || list[i - 1].probability >= d.probability;
}), true);

console.log('\nUpcoming features use completed days only:');
var cleanStart = A.addDays(new Date(), -10);
var cleanSchedules = {
  s1: { medName: 'Metformin', time: '08:00', compartment: 1, date: A.dateKey(cleanStart), frequency: 'daily' }
};
var cleanHistory = {};
for (var c = 10; c >= 1; c--) {
  var cleanKey = A.dateKey(A.addDays(new Date(), -c));
  cleanHistory['clean' + c] = {
    date: cleanKey, time: '08:02', status: 'Taken', scheduledTime: '08:00', compartment: 1
  };
}
var futureScores = R.scoreUpcoming(cleanHistory, cleanSchedules, {
  today: A.dateKey(new Date()),
  nowMinutes: 0,
  daysAhead: 3
});
check('three future days scored', futureScores.upcoming.length, 3);
check('future miss streak stays zero', futureScores.upcoming.every(function (row) {
  return row.features.miss_streak === 0;
}), true);
check('future roll7 stays 100', futureScores.upcoming.every(function (row) {
  return row.features.roll7_taking === 100;
}), true);
check('fresh data has no warning', futureScores.dataWarning, null);

var grouped = R.groupUpcoming(futureScores.upcoming, 3);
check('one daily schedule pattern', grouped.groups.length, 1);
check('grouped daily dose count', grouped.groups[0].count, futureScores.upcoming.length);

var explanation = R.explainRisk({
  time: '08:00',
  features: {
    miss_streak: 4,
    roll7_taking: 20,
    roll30_taking: 30,
    slot_miss_rate_14d: 100,
    median_lateness_7d: 0,
    days_since_last_miss: 2,
    last_outcome: 1,
    is_weekend: 0
  },
  reasons: [{ label: 'miss streak' }, { label: 'monthly adherence' }]
});
check('plain explanation mentions streak', explanation.indexOf('Missed the last 4 doses') >= 0, true);
check('plain explanation mentions adherence', explanation.indexOf('Only 30% taken') >= 0, true);

console.log('\nData freshness guard:');
var staleStart = A.addDays(new Date(), -10);
var staleSchedules = {
  s1: { medName: 'Metformin', time: '08:00', compartment: 1, date: A.dateKey(staleStart), frequency: 'daily' }
};
var staleEmpty = R.scoreUpcoming({}, staleSchedules, {
  today: A.dateKey(new Date()),
  nowMinutes: 0,
  daysAhead: 3
});
check('no history yields a data warning', staleEmpty.dataWarning && staleEmpty.dataWarning.type, 'none');
check('no history yields no scores', staleEmpty.upcoming.length, 0);

var oldHistory = {
  old: {
    date: A.dateKey(staleStart), time: '08:02', status: 'Taken',
    scheduledTime: '08:00', compartment: 1
  }
};
var staleOld = R.scoreUpcoming(oldHistory, staleSchedules, {
  today: A.dateKey(new Date()),
  nowMinutes: 0,
  daysAhead: 3
});
check('old event yields stale warning', staleOld.dataWarning && staleOld.dataWarning.type, 'stale');
check('stale warning reports age', staleOld.dataWarning.daysSince >= 9, true);
check('stale data yields no scores', staleOld.upcoming.length, 0);

console.log('\nForecast:');
var today = new Date();
var start = A.addDays(today, -10);
var schedules = {
  s1: { medName: 'Metformin', time: '08:00', compartment: 1, date: A.dateKey(start), frequency: 'daily' },
  s2: { medName: 'Amlodipine', time: '20:00', compartment: 2, date: A.dateKey(start), frequency: 'daily' }
};
var history = {};
for (var d = 10; d >= 1; d--) {
  var day = A.addDays(today, -d);
  var key = A.dateKey(day);
  history['a' + d] = { date: key, time: '08:02', status: 'Taken', scheduledTime: '08:00', compartment: 1 };
  if (d % 4 !== 0) {
    history['b' + d] = { date: key, time: '20:10', status: 'Taken', scheduledTime: '20:00', compartment: 2 };
  } else {
    history['b' + d] = { date: key, time: '20:01', status: 'Missed', scheduledTime: '20:00', compartment: 2 };
  }
}
var forecast = R.forecastAdherence(history, schedules, 30);
check('forecast returned', forecast != null, true);
check('forecast horizon', forecast.labels.length, 7);
check('forecast starts tomorrow', forecast.labels[0], A.dateKey(A.addDays(today, 1)));
check('forecast does not repeat today', forecast.labels.indexOf(A.dateKey(today)), -1);
check('projected taking bounded', forecast.projectedTaking.every(function (v) {
  return v >= 0 && v <= 100;
}), true);
check('projected timing bounded', forecast.projectedTiming.every(function (v) {
  return v >= 0 && v <= 100;
}), true);
check('warning is boolean', typeof forecast.warning, 'boolean');
check('holt constant series', R._holt([50, 50, 50], 0.5, 0.1, 3).join(','), '50,50,50');

var noRegimen = R.forecastAdherence({}, {}, 30);
check('no regimen yields null forecast', noRegimen, null);
check('stale history yields no forecast', R.forecastAdherence(oldHistory, staleSchedules, 30), null);

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'All assertions passed.') + '\n');
process.exit(failures ? 1 : 0);
