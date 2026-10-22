/*
 * ml-risk.js — browser inference for the SmartMed ML layer.
 *
 * Reads the exported weights in ml-model.js and computes:
 *   - scoreUpcoming(): per-dose non-adherence probability for upcoming doses
 *   - forecastAdherence(): 7-day Holt projection of the daily adherence series
 *
 * Pure functions only, mirroring ml/features.py exactly. The parity fixture in
 * ml/data/parity_fixture.json is asserted by ml-risk.test.js.
 */
(function (global) {
  'use strict';

  var A = global.SmedAnalytics || (typeof require !== 'undefined' ? require('./analytics.js') : null);
  var MODEL = global.SmedMLModel || (typeof require !== 'undefined' ? require('./ml-model.js') : null);

  var TIMING_WINDOW_MIN = 60;
  var STALE_AFTER_DAYS = 3;
  var DEFAULTS = {
    taking: 85,
    daysSinceMiss: 30,
    medianLateness: 0,
    slotMissRate: 30,
    weekdayMissRate: 30,
    maxStreak: 20
  };

  var FACTOR_LABELS = {
    hour_sin: 'time of day',
    hour_cos: 'time of day',
    weekday_sin: 'day of week',
    weekday_cos: 'day of week',
    is_weekend: 'weekend',
    compartment: 'compartment',
    slot_index: 'dose slot',
    roll7_taking: 'recent adherence',
    roll14_taking: '2-week adherence',
    roll30_taking: 'monthly adherence',
    miss_streak: 'miss streak',
    median_lateness_7d: 'recent lateness',
    days_since_last_miss: 'time since last miss',
    slot_miss_rate_14d: 'this slot\u2019s history',
    weekday_miss_rate_28d: 'this weekday\u2019s history',
    last_outcome: 'previous dose',
    slot_median_delay_14d: 'usual delay for this slot'
  };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function sigmoid(z) {
    if (z >= 0) return 1 / (1 + Math.exp(-z));
    var e = Math.exp(z);
    return e / (1 + e);
  }

  function isNonAdherent(assignment) {
    if (!assignment.event) return true;
    return assignment.deltaMin == null || Math.abs(assignment.deltaMin) > TIMING_WINDOW_MIN;
  }

  function dayBefore(key) {
    return A.dateKey(A.addDays(A.parseDateKey(key), -1));
  }

  function latestEventKey(history) {
    var latest = null;
    Object.keys(history || {}).forEach(function (id) {
      var event = history[id];
      if (!event || typeof event.date !== 'string') return;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(event.date)) return;
      if (!latest || event.date > latest) latest = event.date;
    });
    return latest;
  }

  function dueDoseCount(schedules, todayKey, nowMinutes) {
    var fromKey = A.dateKey(A.addDays(A.parseDateKey(todayKey), -STALE_AFTER_DAYS));
    var prescribed = A.expandPrescribed(schedules, fromKey, todayKey);
    var count = 0;
    Object.keys(prescribed).forEach(function (key) {
      prescribed[key].forEach(function (slot) {
        if (key < todayKey || slot.minutes <= nowMinutes) count++;
      });
    });
    return count;
  }

  function detectDataWarning(history, schedules, todayKey, nowMinutes) {
    var lastEvent = latestEventKey(history);
    var daysSince = null;
    if (lastEvent) {
      daysSince = Math.max(0, Math.round(
        (A.parseDateKey(todayKey) - A.parseDateKey(lastEvent)) / 86400000
      ));
      if (daysSince <= STALE_AFTER_DAYS) return null;
    }
    if (!dueDoseCount(schedules, todayKey, nowMinutes)) return null;
    return {
      type: lastEvent ? 'stale' : 'none',
      lastEvent: lastEvent,
      daysSince: daysSince
    };
  }

  function priorRows(history, schedules, targetDateKey, dataEndKey) {
    var fromKey = A.dateKey(A.addDays(A.parseDateKey(targetDateKey), -14));
    var naturalEnd = dayBefore(targetDateKey);
    var endKey = dataEndKey && dataEndKey < naturalEnd ? dataEndKey : naturalEnd;
    return A.buildDailyTable(history, schedules, fromKey, endKey, null, null);
  }

  function generalStats(rows) {
    var takingRows = rows.filter(function (row) { return row.P > 0; });
    function rolling(count) {
      var slice = takingRows.slice(-count);
      var value = A.mean(slice.map(function (row) { return row.takingPct; }));
      return value == null ? DEFAULTS.taking : value;
    }

    var streak = 0;
    for (var r = rows.length - 1; r >= 0; r--) {
      var stopped = false;
      for (var a = rows[r].assignments.length - 1; a >= 0; a--) {
        if (isNonAdherent(rows[r].assignments[a])) {
          streak++;
        } else {
          stopped = true;
          break;
        }
      }
      if (stopped) break;
    }

    var deltas = [];
    rows.slice(-7).forEach(function (row) {
      row.assignments.forEach(function (assignment) {
        if (assignment.event && assignment.deltaMin != null) deltas.push(assignment.deltaMin);
      });
    });
    var lateness = A.median(deltas);
    if (lateness == null) lateness = DEFAULTS.medianLateness;

    return {
      roll7: rolling(7),
      roll14: rolling(14),
      roll30: rolling(30),
      streak: Math.min(streak, DEFAULTS.maxStreak),
      medianLateness: lateness
    };
  }

  function daysSinceMiss(rows, targetDateKey) {
    var target = A.parseDateKey(targetDateKey);
    var lastMiss = null;
    rows.forEach(function (row) {
      if (row.assignments.some(isNonAdherent)) {
        var day = A.parseDateKey(row.date);
        if (!lastMiss || day > lastMiss) lastMiss = day;
      }
    });
    if (!lastMiss) return DEFAULTS.daysSinceMiss;
    return Math.min(Math.round((target - lastMiss) / 86400000), DEFAULTS.daysSinceMiss);
  }

  function slotStats(rows, slot, targetWeekday) {
    var recent = rows.slice(-14);
    var slotAssignments = [];
    recent.forEach(function (row) {
      row.assignments.forEach(function (assignment) {
        if (assignment.slot.minutes === slot.minutes) slotAssignments.push(assignment);
      });
    });
    var slotMissRate = slotAssignments.length
      ? 100 * slotAssignments.filter(isNonAdherent).length / slotAssignments.length
      : DEFAULTS.slotMissRate;

    var weekdayAssignments = [];
    rows.slice(-28).forEach(function (row) {
      if (A.parseDateKey(row.date).getDay() !== targetWeekday) return;
      weekdayAssignments = weekdayAssignments.concat(row.assignments);
    });
    var weekdayMissRate = weekdayAssignments.length
      ? 100 * weekdayAssignments.filter(isNonAdherent).length / weekdayAssignments.length
      : DEFAULTS.weekdayMissRate;

    var lastAssignment = null;
    for (var r = rows.length - 1; r >= 0; r--) {
      if (rows[r].assignments.length) {
        lastAssignment = rows[r].assignments[rows[r].assignments.length - 1];
        break;
      }
    }
    var lastOutcome = lastAssignment && isNonAdherent(lastAssignment) ? 1 : 0;

    var delays = [];
    slotAssignments.forEach(function (assignment) {
      if (assignment.event && assignment.deltaMin != null) delays.push(assignment.deltaMin);
    });
    var slotMedianDelay = A.median(delays);
    if (slotMedianDelay == null) slotMedianDelay = 0;

    return {
      slotMissRate: slotMissRate,
      weekdayMissRate: weekdayMissRate,
      lastOutcome: lastOutcome,
      slotMedianDelay: slotMedianDelay
    };
  }

  function featuresFor(history, schedules, targetDateKey, minutes, slotIndex, dataEndKey) {
    var rows = priorRows(history, schedules, targetDateKey, dataEndKey);
    var prescribed = A.expandPrescribed(schedules, targetDateKey, targetDateKey)[targetDateKey] || [];
    var slot = null;
    prescribed.forEach(function (candidate, index) {
      if (candidate.minutes === minutes && (slotIndex == null || index === slotIndex)) slot = candidate;
    });
    if (!slot) return null;

    var day = A.parseDateKey(targetDateKey);
    var weekday = day.getDay();
    var general = generalStats(rows);
    var specific = slotStats(rows, slot, weekday);
    var hour = slot.minutes / 60;

    return {
      hour_sin: Math.sin(2 * Math.PI * hour / 24),
      hour_cos: Math.cos(2 * Math.PI * hour / 24),
      weekday_sin: Math.sin(2 * Math.PI * weekday / 7),
      weekday_cos: Math.cos(2 * Math.PI * weekday / 7),
      is_weekend: weekday === 0 || weekday === 6 ? 1 : 0,
      compartment: slot.compartment != null && slot.compartment !== '' ? Number(slot.compartment) || 1 : 1,
      slot_index: slotIndex == null ? prescribed.indexOf(slot) : slotIndex,
      roll7_taking: general.roll7,
      roll14_taking: general.roll14,
      roll30_taking: general.roll30,
      miss_streak: general.streak,
      median_lateness_7d: general.medianLateness,
      days_since_last_miss: daysSinceMiss(rows, targetDateKey),
      slot_miss_rate_14d: specific.slotMissRate,
      weekday_miss_rate_28d: specific.weekdayMissRate,
      last_outcome: specific.lastOutcome,
      slot_median_delay_14d: specific.slotMedianDelay
    };
  }

  function contributions(features) {
    if (!MODEL || !MODEL.coefficients) return [];
    return MODEL.features.map(function (name, index) {
      var scaled = (features[name] - MODEL.scaler.mean[index]) / MODEL.scaler.scale[index];
      return {
        feature: name,
        label: FACTOR_LABELS[name] || name,
        contribution: MODEL.coefficients[index] * scaled
      };
    }).sort(function (a, b) { return Math.abs(b.contribution) - Math.abs(a.contribution); });
  }

  function scoreFeatures(features) {
    if (!MODEL || !MODEL.coefficients) return null;
    var z = MODEL.intercept;
    MODEL.features.forEach(function (name, index) {
      z += MODEL.coefficients[index] *
        ((features[name] - MODEL.scaler.mean[index]) / MODEL.scaler.scale[index]);
    });
    var probability = sigmoid(z);
    var reasons = contributions(features).slice(0, 2).map(function (item) {
      return {
        label: item.label,
        direction: item.contribution >= 0 ? 'raises risk' : 'lowers risk',
        contribution: item.contribution
      };
    });
    return {
      probability: probability,
      level: probability >= 0.6 ? 'high' : (probability >= 0.3 ? 'medium' : 'low'),
      reasons: reasons,
      features: features
    };
  }

  function countText(value) {
    var n = Math.round(value);
    return n + (n === 1 ? ' dose' : ' doses');
  }

  function streakMessage(features) {
    var n = Math.round(features.miss_streak || 0);
    if (n >= DEFAULTS.maxStreak) return 'Missed ' + DEFAULTS.maxStreak + '+ doses in a row';
    if (n > 0) return 'Missed the last ' + countText(n) + ' in a row';
    return null;
  }

  function adherenceMessage(features, days) {
    var value = features['roll' + days + '_taking'];
    if (typeof value !== 'number' || value >= 80) return null;
    if (value <= 0) return 'No doses taken in the last ' + days + ' days';
    return 'Only ' + Math.round(value) + '% taken in the last ' + days + ' days';
  }

  function slotMessage(features, dose) {
    var value = features.slot_miss_rate_14d;
    if (typeof value !== 'number' || value < 50) return null;
    var time = dose && dose.time ? dose.time : 'this time';
    if (value >= 99) return 'Doses at ' + time + ' have been missed recently';
    return 'Doses at ' + time + ' are missed ' + Math.round(value) + '% of the time';
  }

  function weekdayMessage(features) {
    var value = features.weekday_miss_rate_28d;
    if (typeof value !== 'number' || value < 50) return null;
    return 'Doses on this weekday are missed ' + Math.round(value) + '% of the time';
  }

  function latenessMessage(features) {
    var value = features.median_lateness_7d;
    if (typeof value !== 'number' || value <= 15) return null;
    if (value > 60) return 'Doses are usually more than 1 hour late';
    return 'Doses are usually about ' + Math.round(value) + ' minutes late';
  }

  function daysSinceMessage(features) {
    var value = features.days_since_last_miss;
    if (typeof value !== 'number') return null;
    if (value === 1) return 'A dose was missed yesterday';
    if (value > 1 && value <= 7) return 'The last missed dose was ' + Math.round(value) + ' days ago';
    return null;
  }

  function previousMessage(features) {
    return features.last_outcome >= 1 ? 'The previous dose was missed or late' : null;
  }

  function slotDelayMessage(features, dose) {
    var value = features.slot_median_delay_14d;
    if (typeof value !== 'number' || value <= 15) return null;
    if (value > 60) return 'Doses at ' + (dose && dose.time ? dose.time : 'this time') + ' are usually more than 1 hour late';
    return 'Doses at ' + (dose && dose.time ? dose.time : 'this time') + ' are usually about ' + Math.round(value) + ' minutes late';
  }

  function reasonMessage(label, features, dose) {
    switch (label) {
      case 'miss streak': return streakMessage(features);
      case 'recent adherence': return adherenceMessage(features, 7);
      case '2-week adherence': return adherenceMessage(features, 14);
      case 'monthly adherence': return adherenceMessage(features, 30);
      case 'this slot\u2019s history': return slotMessage(features, dose);
      case 'this weekday\u2019s history': return weekdayMessage(features);
      case 'recent lateness': return latenessMessage(features);
      case 'time since last miss': return daysSinceMessage(features);
      case 'previous dose': return previousMessage(features);
      case 'usual delay for this slot': return slotDelayMessage(features, dose);
      case 'weekend': return features.is_weekend ? 'Weekend doses need extra attention' : null;
      default: return null;
    }
  }

  function explainRisk(dose) {
    var features = (dose && dose.features) || {};
    var messages = [];
    function add(message) {
      if (message && messages.indexOf(message) === -1 && messages.length < 2) messages.push(message);
    }
    ((dose && dose.reasons) || []).forEach(function (reason) {
      add(reasonMessage(reason.label, features, dose));
    });
    if (messages.length < 2) {
      add(streakMessage(features));
      add(adherenceMessage(features, 7));
      add(adherenceMessage(features, 30));
      add(slotMessage(features, dose));
      add(latenessMessage(features));
      add(previousMessage(features));
    }
    return messages.join(' \u00b7 ') || 'Based on the recent dose pattern.';
  }

  function groupUpcoming(rows, limit) {
    var groups = {};
    (rows || []).forEach(function (row) {
      var key = [row.medName || '', row.minutes, row.compartment == null ? '' : row.compartment].join('|');
      var group = groups[key];
      if (!group) {
        group = groups[key] = {
          key: key,
          medName: row.medName,
          time: row.time,
          minutes: row.minutes,
          compartment: row.compartment,
          count: 0,
          firstDate: row.date,
          exampleDate: row.date,
          probability: row.probability,
          level: row.level,
          reasons: row.reasons,
          features: row.features
        };
      }
      group.count++;
      if (row.date < group.firstDate) group.firstDate = row.date;
      if (row.probability > group.probability) {
        group.probability = row.probability;
        group.level = row.level;
        group.reasons = row.reasons;
        group.features = row.features;
        group.exampleDate = row.date;
      }
    });
    var list = Object.keys(groups).map(function (key) { return groups[key]; })
      .sort(function (a, b) { return b.probability - a.probability; });
    return {
      groups: list.slice(0, limit || 3),
      total: list.length,
      doses: (rows || []).length
    };
  }

  function scoreUpcoming(history, schedules, options) {
    var opts = options || {};
    var daysAhead = opts.daysAhead || 7;
    var now = opts.now ? new Date(opts.now) : new Date();
    var todayKey = opts.today || A.dateKey(now);
    var nowMinutes = opts.nowMinutes != null ? opts.nowMinutes : now.getHours() * 60 + now.getMinutes();
    var endKey = A.dateKey(A.addDays(A.parseDateKey(todayKey), daysAhead - 1));
    var lastCompletedKey = A.dateKey(A.addDays(A.parseDateKey(todayKey), -1));
    var prescribed = A.expandPrescribed(schedules, todayKey, endKey);
    var warning = detectDataWarning(history, schedules, todayKey, nowMinutes);
    if (warning) {
      return { upcoming: [], top: [], model: modelInfo(), dataWarning: warning };
    }
    var rows = [];

    Object.keys(prescribed).sort().forEach(function (dateKey) {
      prescribed[dateKey].forEach(function (slot, slotIndex) {
        if (dateKey === todayKey && slot.minutes <= nowMinutes) return;
        var features = featuresFor(history, schedules, dateKey, slot.minutes, slotIndex, lastCompletedKey);
        if (!features) return;
        var scored = scoreFeatures(features);
        if (!scored) return;
        rows.push({
          date: dateKey,
          time: slot.time,
          minutes: slot.minutes,
          slotIndex: slotIndex,
          medName: slot.medName,
          compartment: slot.compartment,
          probability: scored.probability,
          level: scored.level,
          reasons: scored.reasons,
          features: features
        });
      });
    });

    rows.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.minutes - b.minutes;
    });

    var top = rows.slice().sort(function (a, b) { return b.probability - a.probability; });
    return { upcoming: rows, top: top.slice(0, 5), model: modelInfo(), dataWarning: null };
  }

  function holt(series, alpha, beta, horizon, phi) {
    if (!series.length) return [];
    var dampingFactor = phi == null ? 1 : phi;
    if (series.length === 1) {
      return Array.apply(null, Array(horizon)).map(function () { return series[0]; });
    }
    var level = series[0];
    var trend = series[1] - series[0];
    for (var i = 1; i < series.length; i++) {
      var previous = level;
      level = alpha * series[i] + (1 - alpha) * (level + dampingFactor * trend);
      trend = beta * (level - previous) + (1 - beta) * dampingFactor * trend;
    }
    var out = [];
    var damping = 0;
    for (var step = 1; step <= horizon; step++) {
      damping += Math.pow(dampingFactor, step);
      out.push(level + damping * trend);
    }
    return out;
  }

  function forecastAdherence(history, schedules, windowDays) {
    if (!MODEL || !MODEL.forecast || !A) return null;
    var now = new Date();
    if (detectDataWarning(history, schedules, A.dateKey(now),
        now.getHours() * 60 + now.getMinutes())) return null;
    var result = A.analyse(history, schedules, windowDays || 30);
    // Today is partial: its remaining doses are not misses yet. Forecasting from a
    // half-finished day would project an artificial plunge, so use completed days only.
    var todayKey = A.dateKey(new Date());
    var rows = result.rows.filter(function (row) {
      return !row.excluded && row.P > 0 && row.date !== todayKey;
    });
    var taking = rows.map(function (row) { return row.takingPct; });
    var timing = rows.map(function (row) { return row.timingPct; });
    if (taking.length < 3) return null;

    var horizon = MODEL.forecast.horizon || 7;
    var alpha = MODEL.forecast.alpha;
    var beta = MODEL.forecast.beta;
    var phi = MODEL.forecast.phi == null ? 1 : MODEL.forecast.phi;
    // The last fitted day is yesterday. Step 1 of the Holt projection is today, which is
    // still partial, so drop it and label the seven projected points tomorrow onwards.
    var projectedTaking = holt(taking, alpha, beta, horizon + 1, phi)
      .slice(1).map(function (v) { return clamp(v, 0, 100); });
    var projectedTiming = holt(timing, alpha, beta, horizon + 1, phi)
      .slice(1).map(function (v) { return clamp(v, 0, 100); });

    var lastDate = A.parseDateKey(rows[rows.length - 1].date);
    var labels = projectedTaking.map(function (_v, index) {
      return A.dateKey(A.addDays(lastDate, index + 2));
    });
    var projectedAverage = A.mean(projectedTaking);

    return {
      labels: labels,
      projectedTaking: projectedTaking,
      projectedTiming: projectedTiming,
      projectedAverage: projectedAverage,
      warning: projectedAverage != null && projectedAverage < 80,
      alpha: alpha,
      beta: beta,
      phi: phi
    };
  }

  function modelInfo() {
    if (!MODEL) return null;
    return {
      version: MODEL.version,
      model: MODEL.model,
      simulated_rows: MODEL.data_sources ? MODEL.data_sources.simulated_rows : null,
      real_rows: MODEL.data_sources ? MODEL.data_sources.real_rows : null,
      real_patients: MODEL.data_sources ? MODEL.data_sources.real_patients : null,
      real_calibration_rows: MODEL.calibration && MODEL.calibration.real
        ? MODEL.calibration.real.calibration_rows : 0,
      auc: MODEL.metrics && MODEL.metrics.simulated_holdout
        ? MODEL.metrics.simulated_holdout.roc_auc : null,
      forecast: MODEL.forecast || null
    };
  }

  global.SmedRisk = {
    scoreUpcoming: scoreUpcoming,
    forecastAdherence: forecastAdherence,
    modelInfo: modelInfo,
    groupUpcoming: groupUpcoming,
    explainRisk: explainRisk,
    sigmoid: sigmoid,
    staleAfterDays: STALE_AFTER_DAYS,
    _featuresAt: featuresFor,
    _scoreFeatures: scoreFeatures,
    _holt: holt
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.SmedRisk;
})(typeof window !== 'undefined' ? window : globalThis);
