/*
 * analytics-ui.js — renders the Analytics section.
 *
 * Reads from window.SmedAnalytics (pure computation, analytics.js) and paints. All the
 * arithmetic lives there; this file only decides how it looks. Exposes
 * window.SmedAnalyticsUI.render(history, schedules) for app.js to call whenever the
 * patient's data changes.
 */
(function (global) {
  'use strict';

  var A = global.SmedAnalytics;
  var R = global.SmedRisk;

  // Two-series categorical palette. NOT the dashboard's --emerald-heal/--amber-caution:
  // those sit outside the dark-mode OKLCH lightness band (L 0.696 / 0.769 vs the 0.48-0.67
  // band) and separate by only dE 8.9 under protanopia. These steps pass all six checks
  // (CVD dE 10.2 deutan, normal-vision dE 28.0, contrast > 3:1 on #121217).
  var COLOR_TAKING = '#0e9f6e';
  var COLOR_TIMING = '#c2410c';

  // Sequential ramp for the heatmap: one hue, dim -> bright. On a dark surface the high
  // end must be the bright end, or the worst cells disappear into the background.
  var MISS_RAMP = ['#3f1220', '#7a1a30', '#9f1239', '#e11d48', '#fb7185'];

  var GRID_COLOR = 'rgba(255,255,255,0.06)';
  var TICK_COLOR = '#94a3b8';
  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Cells with fewer than this many prescribed doses are dimmed: 1 miss out of 1 is 100%,
  // and should not shout as loudly as 5 out of 20.
  var SPARSE_THRESHOLD = 3;

  var state = { windowDays: 30, history: null, schedules: null, lastResult: null };
  var trendChart = null;
  var wired = false;

  function el(id) { return document.getElementById(id); }

  function fmtPct(v) {
    return v === null || v === undefined || isNaN(v) ? '--' : v.toFixed(1) + '%';
  }

  function fmtDelay(mins) {
    if (mins === null || mins === undefined) return '--';
    var r = Math.round(mins);
    if (r === 0) return 'on time';
    var abs = Math.abs(r);
    var text = abs >= 60
      ? Math.floor(abs / 60) + 'h ' + (abs % 60) + 'm'
      : abs + ' min';
    return text + (r > 0 ? ' late' : ' early');
  }

  // --- KPI tiles ------------------------------------------------------------------

  function renderTiles(summary) {
    var tiles = [
      ['taking', summary.taking],
      ['timing', summary.timing],
      ['correct', summary.correctDosing]
    ];

    tiles.forEach(function (pair) {
      var node = el('metric-' + pair[0]);
      var sub = el('metric-' + pair[0] + '-sub');
      var m = pair[1];
      if (!node || !sub) return;

      node.textContent = fmtPct(m.value);
      // Colour the headline only when it carries a judgement, and never as the sole
      // signal -- the numerator/denominator below always spells it out.
      node.style.color = m.value === null ? 'var(--text-muted)'
        : (m.value >= A.ADHERENCE_THRESHOLD ? COLOR_TAKING : 'var(--rose-alert)');

      sub.textContent = m.denominator
        ? m.numerator + ' of ' + m.denominator + (pair[0] === 'correct' ? ' days' : ' doses')
        : 'No prescribed doses in window';
    });
  }

  // --- Daily trend ----------------------------------------------------------------

  function renderTrend(result) {
    var canvas = el('dailyAdherenceChart');
    var empty = el('trend-empty');
    var legend = el('trend-legend');
    if (!canvas) return;

    var rows = result.rows.filter(function (r) { return !r.excluded && r.P > 0; });

    if (!rows.length) {
      if (trendChart) { trendChart.destroy(); trendChart = null; }
      canvas.style.display = 'none';
      if (legend) legend.style.display = 'none';
      if (empty) empty.style.display = 'block';
      return;
    }
    canvas.style.display = '';
    if (legend) legend.style.display = 'flex';
    if (empty) empty.style.display = 'none';

    var forecast = R && R.forecastAdherence
      ? R.forecastAdherence(state.history, state.schedules, state.windowDays)
      : null;

    var labels = rows.map(function (r) { return r.date; });
    var takingData = rows.map(function (r) { return r.takingPct; });
    var timingData = rows.map(function (r) { return r.timingPct; });
    var showPoints = rows.length <= 31;

    var datasets = [
      {
        label: 'Doses taken',
        data: takingData,
        borderColor: COLOR_TAKING,
        backgroundColor: COLOR_TAKING,
        borderWidth: 2,
        pointRadius: showPoints ? 4 : 0,
        pointHoverRadius: 6,
        tension: 0.25
      },
      {
        label: 'On time',
        data: timingData,
        borderColor: COLOR_TIMING,
        backgroundColor: COLOR_TIMING,
        borderWidth: 2,
        // Secondary encoding: the two series differ by dash pattern as well as hue,
        // so they stay distinguishable in greyscale and under CVD.
        borderDash: [5, 4],
        pointRadius: showPoints ? 4 : 0,
        pointHoverRadius: 6,
        tension: 0.25
      }
    ];

    if (forecast) {
      // Pad the forecast series with nulls so it starts on the last observed point, then
      // continues as a dashed projection. The bridge keeps the eye on one continuous series.
      labels = labels.concat(forecast.labels);
      var padTaking = new Array(rows.length).fill(null);
      var padTiming = new Array(rows.length).fill(null);
      padTaking[rows.length - 1] = takingData[takingData.length - 1];
      padTiming[rows.length - 1] = timingData[timingData.length - 1];

      datasets.push({
        label: 'Expected',
        data: padTaking.concat(forecast.projectedTaking),
        borderColor: COLOR_TAKING,
        backgroundColor: COLOR_TAKING,
        borderWidth: 2,
        borderDash: [2, 4],
        pointRadius: 0,
        pointHoverRadius: 0,
        tension: 0.25
      });
      datasets.push({
        label: 'Expected on time',
        data: padTiming.concat(forecast.projectedTiming),
        borderColor: COLOR_TIMING,
        backgroundColor: COLOR_TIMING,
        borderWidth: 2,
        borderDash: [2, 4],
        pointRadius: 0,
        pointHoverRadius: 0,
        tension: 0.25
      });
    }

    var caption = el('trend-caption');
    if (caption) {
      var base = 'Each point is one day. The two lines show doses taken and doses taken on time.';
      caption.textContent = forecast
        ? base + ' The dashed line is an estimate from the last 7 days, not recorded data.'
        : base;
    }

    var data = { labels: labels, datasets: datasets };

    // The 80% threshold, drawn as a recessive dashed rule behind the data.
    var thresholdLine = {
      id: 'thresholdLine',
      beforeDatasetsDraw: function (chart) {
        var y = chart.scales.y, ctx = chart.ctx;
        if (!y) return;
        var yPos = y.getPixelForValue(A.ADHERENCE_THRESHOLD);
        ctx.save();
        ctx.strokeStyle = TICK_COLOR;
        ctx.globalAlpha = 0.45;
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(chart.chartArea.left, yPos);
        ctx.lineTo(chart.chartArea.right, yPos);
        ctx.stroke();
        ctx.restore();
      }
    };

    if (trendChart) trendChart.destroy();
    trendChart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: data,
      plugins: [thresholdLine],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          // Our own HTML legend sits in the card header, so Chart.js's is off.
          legend: { display: false },
          tooltip: {
            backgroundColor: '#0a0a0c',
            borderColor: 'rgba(255,255,255,0.12)',
            borderWidth: 1,
            titleColor: '#f8fafc',
            bodyColor: '#94a3b8',
            padding: 12,
            displayColors: true,
            callbacks: {
              afterTitle: function (items) {
                var row = rows[items[0].dataIndex];
                if (!row) return 'Forecast  ·  model projection';
                return WEEKDAYS[row.weekday] + '  ·  ' + row.N + ' of ' + row.P + ' doses';
              },
              label: function (ctx) {
                return ' ' + ctx.dataset.label + ': ' + fmtPct(ctx.parsed.y);
              }
            }
          }
        },
        scales: {
          y: {
            min: 0,
            max: 105,
            ticks: { color: TICK_COLOR, stepSize: 25, callback: function (v) { return v + '%'; } },
            grid: { color: GRID_COLOR, drawBorder: false }
          },
          x: {
            ticks: {
              color: TICK_COLOR,
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 8,
              callback: function (v, i) { return labels[i].slice(5); } // MM-DD
            },
            grid: { display: false }
          }
        }
      }
    });
  }

  // --- Heatmap --------------------------------------------------------------------

  function rampColor(rate) {
    var i = Math.min(MISS_RAMP.length - 1, Math.floor((rate / 100) * MISS_RAMP.length));
    return MISS_RAMP[rate === 0 ? 0 : Math.max(1, i)];
  }

  function renderHeatmap(heatmap) {
    var host = el('miss-heatmap');
    var empty = el('heatmap-empty');
    var scale = el('heatmap-scale');
    if (!host) return;

    host.innerHTML = '';
    var hours = heatmap.activeHours;

    if (!hours.length) {
      if (empty) empty.style.display = 'block';
      if (scale) scale.style.display = 'none';
      return;
    }
    if (empty) empty.style.display = 'none';
    if (scale) scale.style.display = 'flex';

    var grid = document.createElement('div');
    grid.className = 'heatmap-grid';
    grid.style.gridTemplateColumns = '46px repeat(' + hours.length + ', minmax(34px, 1fr))';

    // Column headers
    grid.appendChild(document.createElement('div'));
    hours.forEach(function (h) {
      var c = document.createElement('div');
      c.className = 'heatmap-axis col';
      c.textContent = (h < 10 ? '0' : '') + h + ':00';
      grid.appendChild(c);
    });

    for (var w = 0; w < 7; w++) {
      var rowLabel = document.createElement('div');
      rowLabel.className = 'heatmap-axis row';
      rowLabel.textContent = WEEKDAYS[w];
      grid.appendChild(rowLabel);

      hours.forEach(function (h, _i) {
        var cell = heatmap.grid[w][h];
        var node = document.createElement('div');
        node.className = 'heatmap-cell';

        if (!cell.total) {
          node.className += ' empty';
          node.title = WEEKDAYS[w] + ' ' + h + ':00 — no doses scheduled';
        } else {
          node.style.background = rampColor(cell.rate);
          // Text sits on a coloured mark, so it uses a fixed high-contrast ink rather
          // than a series colour.
          node.style.color = cell.rate > 55 ? '#fff5f7' : '#fecdd3';
          node.textContent = Math.round(cell.rate) + '%';
          if (cell.total < SPARSE_THRESHOLD) node.className += ' sparse';
          node.title = WEEKDAYS[w] + ' ' + h + ':00 — ' + cell.missed + ' missed of ' +
            cell.total + ' prescribed (' + Math.round(cell.rate) + '%)' +
            (cell.total < SPARSE_THRESHOLD ? '  · small sample' : '');
        }
        grid.appendChild(node);
      });
    }

    host.appendChild(grid);
  }

  // --- Window facts ---------------------------------------------------------------

  function renderFacts(result) {
    var host = el('window-facts');
    if (!host) return;
    var s = result.summary, l = result.lateness;

    var facts = [
      ['Days observed', s.daysObserved],
      ['Doses prescribed', s.totalPrescribed],
      ['Doses taken', s.totalTaken],
      ['Doses missed', s.totalMissed],
      ['Median lateness', l.count ? fmtDelay(l.median) : '--'],
      ['Latest dose', l.count ? fmtDelay(l.latest) : '--'],
      ['Repeat actuations removed', s.duplicatesRemoved],
      ['Days excluded (non-use)', s.daysExcluded]
    ];

    host.innerHTML = facts.map(function (f) {
      return '<div><dt>' + f[0] + '</dt><dd>' + f[1] + '</dd></div>';
    }).join('');
  }

  // --- Methods panel --------------------------------------------------------------

  /*
   * EMERGE-style reporting: every displayed metric states its definition, numerator,
   * denominator and observation window, so a reader can check the arithmetic.
   */
  function renderMethods(result) {
    var host = el('methods-body');
    if (!host) return;
    var s = result.summary, p = result.params, w = result.window;

    var rows = [
      ['Taking adherence', s.taking.definition, s.taking.numerator + ' / ' + s.taking.denominator, fmtPct(s.taking.value)],
      ['Timing adherence', s.timing.definition, s.timing.numerator + ' / ' + s.timing.denominator, fmtPct(s.timing.value)],
      ['Correct-dosing days', s.correctDosing.definition, s.correctDosing.numerator + ' / ' + s.correctDosing.denominator, fmtPct(s.correctDosing.value)]
    ];

    host.innerHTML =
      '<table><thead><tr>' +
        '<th class="vital-label">METRIC</th>' +
        '<th class="vital-label">DEFINITION</th>' +
        '<th class="vital-label">NUM / DENOM</th>' +
        '<th class="vital-label">VALUE</th>' +
      '</tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr>' +
          '<td style="font-weight:700;">' + r[0] + '</td>' +
          '<td style="color:var(--text-muted);">' + r[1] + '</td>' +
          '<td class="formula">' + r[2] + '</td>' +
          '<td style="font-weight:800;">' + r[3] + '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table>' +

      '<div class="methods-citation">' +
        '<strong style="color:var(--text-primary);">Observation window:</strong> ' +
          w.from + ' to ' + w.to + ' (' + w.days + ' days); ' +
          s.daysObserved + ' scored, ' + s.daysExcluded + ' excluded as documented non-use, ' +
          s.daysWithoutRegimen + ' with no prescribed dose.<br>' +
        '<strong style="color:var(--text-primary);">Timing window:</strong> &plusmn;' +
          p.timingWindowMin + ' minutes around the scheduled time.<br>' +
        '<strong style="color:var(--text-primary);">Repeat-actuation rule:</strong> IR triggers ' +
          'on the same compartment within ' + p.dedupWindowMin + ' minutes count as one dose ' +
          '(' + s.duplicatesRemoved + ' collapsed in this window).<br>' +
        '<strong style="color:var(--text-primary);">Aggregation:</strong> each statistic is ' +
          'computed per day and then averaged across the window' +
          (p.cappedAt100 ? ', with daily values capped at 100%' : '') + ' — it is not pooled ' +
          'across the whole period.<br><br>' +
        '<strong style="color:var(--text-primary);">Method source:</strong> McGrady ME, Ramsey RR. ' +
          '<em>Using Electronic Monitoring Devices to Assess Medication Adherence: a Research ' +
          'Methods Framework.</em> J Gen Intern Med. 2020;35(9):2707–2714. ' +
          'Taking and timing adherence are reported side by side because the choice of ' +
          'calculation method moves the headline figure by ~25 points on identical behaviour ' +
          '(Rohay &amp; Dunbar-Jacob, Front Pharmacol. 2024;15:1460327). ' +
          'Full provenance in <code>RESEARCH_BASIS.md</code>.' +
      '</div>' +
      (R && R.modelInfo && R.modelInfo() ? (function () {
        var info = R.modelInfo();
        return '<div class="methods-citation" style="margin-top:1.25rem;">' +
          '<strong style="color:var(--text-primary);">Risk model:</strong> L2-regularised ' +
            'logistic regression over 17 engineered features (adherence windows, miss streaks, ' +
            'slot/weekday history, timing drift, calendar position). Trained offline in Python ' +
            'on a temporal split (last 20% of days); only the frozen coefficients ship to the browser. ' +
            'Holdout AUC ' + (info.auc != null ? info.auc.toFixed(2) : '--') + '. ' +
          '<strong style="color:var(--text-primary);">Forecast:</strong> Holt linear-trend ' +
            'exponential smoothing (alpha ' + (info.forecast ? info.forecast.alpha : '--') +
            ', beta ' + (info.forecast ? info.forecast.beta : '--') +
            ', selected on a held-out tail) projects the next 7 days; it is a projection, not ' +
            'recorded data. ' +
          '<strong style="color:var(--text-primary);">Calibration:</strong> intercept corrected ' +
            'to the observed base rate; real pilot data re-weights it at retrain once 20+ rows exist. ' +
          'Probabilities support—not replace—clinical judgement. ' +
          'Full model card in <code>ml/model_card.md</code>.' +
        '</div>';
      })() : '');
  }

  // --- Simulated-data banner ------------------------------------------------------

  function renderSimBanner(history) {
    var section = el('section-analytics');
    if (!section) return;
    var existing = el('sim-data-banner');
    var count = 0;
    if (history) {
      Object.keys(history).forEach(function (k) {
        if (history[k] && history[k].simulated === true) count++;
      });
    }

    if (!count) {
      if (existing) existing.remove();
      return;
    }
    if (!existing) {
      existing = document.createElement('div');
      existing.id = 'sim-data-banner';
      existing.className = 'sim-banner';
      var grid = section.querySelector('.grid');
      grid.insertBefore(existing, grid.firstChild);
    }
    existing.textContent = 'This report includes ' + count + ' test event' +
      (count === 1 ? '' : 's') + '. Clear them before relying on these numbers.';
  }

  // --- ML risk radar --------------------------------------------------------------

  function riskDateLabel(key) {
    return A.parseDateKey(key).toLocaleDateString(undefined, {
      weekday: 'short', day: 'numeric', month: 'short'
    });
  }

  var NO_UPCOMING_TEXT = 'No doses scheduled yet. Add the first medicine to start.';

  function riskWarningText(warning) {
    if (warning.type === 'none') {
      return 'Risk paused — no dose has been recorded yet. ' +
        'Log the first dose to start scoring.';
    }
    var when = warning.lastEvent ? riskDateLabel(warning.lastEvent) : 'recently';
    var ago = warning.daysSince != null ? ' (' + warning.daysSince + ' days ago)' : '';
    return 'Risk paused — the box has not sent a dose update since ' + when + ago + '. ' +
      'Check that it is powered on and connected. Scores return when new doses arrive.';
  }

  function probabilityBand(probability) {
    if (probability >= 0.9) return 'Very high chance';
    if (probability >= 0.6) return 'High chance';
    if (probability >= 0.3) return 'Medium chance';
    return 'Low chance';
  }

  function clockLabel(value) {
    if (!value) return 'this dose';
    var parts = String(value).split(':');
    var h = Number(parts[0]);
    var m = Number(parts[1]);
    if (isNaN(h) || isNaN(m)) return value;
    var d = new Date();
    d.setHours(h, m, 0, 0);
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function riskAction(dose) {
    if (dose.level === 'low') return 'No action needed. Keep the current routine.';
    var f = dose.features || {};
    if (f.is_weekend >= 0.5) {
      return 'Plan the weekend dose ahead — a reminder or a check-in can help.';
    }
    if (f.slot_miss_rate_14d >= 50) {
      return 'Set a reminder shortly before ' + clockLabel(dose.time) + '.';
    }
    if (typeof f.roll7_taking === 'number' && f.roll7_taking < 80) {
      return 'Check in before this dose this week.';
    }
    return 'A reminder before this dose can help.';
  }

  function renderRisk() {
    var list = el('risk-list');
    var empty = el('risk-empty');
    var summary = el('risk-summary');
    var note = el('risk-model-note');
    var headline = el('risk-headline');
    if (!list) return;

    list.innerHTML = '';
    if (summary) summary.innerHTML = '';
    if (empty) {
      empty.className = 'empty-state';
      empty.textContent = NO_UPCOMING_TEXT;
      empty.style.display = 'none';
    }
    if (headline) {
      headline.textContent = '';
      headline.className = 'risk-headline';
      headline.style.display = 'none';
    }

    var info = R && R.modelInfo ? R.modelInfo() : null;
    if (note) {
      if (info) {
        var source = info.real_rows
          ? info.real_rows + ' real' +
            (info.real_calibration_rows ? '' : ' (below calibration minimum)') + ' + '
          : '';
        note.textContent = 'Model ' + info.version + ' · ' + source +
          (info.simulated_rows || 0).toLocaleString() + ' simulated labelled doses · ' +
          'holdout AUC ' + (info.auc != null ? info.auc.toFixed(2) : '--') +
          '. Probabilities are decision support, not a diagnosis.';
      } else {
        note.textContent = 'ML layer unavailable.';
      }
    }

    if (!R || !A) return;

    var result = R.scoreUpcoming(state.history, state.schedules, { daysAhead: 7 });

    if (result.dataWarning) {
      if (headline) {
        headline.textContent = 'Risk paused';
        headline.className = 'risk-headline warning';
        headline.style.display = 'block';
      }
      if (empty) {
        empty.textContent = riskWarningText(result.dataWarning);
        empty.className = 'empty-state risk-warning';
        empty.style.display = 'block';
      }
      return;
    }

    var doses = result.upcoming || [];
    if (!doses.length) {
      if (empty) empty.style.display = 'block';
      return;
    }

    var counts = { high: 0, medium: 0, low: 0 };
    doses.forEach(function (d) { counts[d.level]++; });

    var grouped = R.groupUpcoming
      ? R.groupUpcoming(doses, 3)
      : { groups: result.top || [], total: (result.top || []).length, doses: doses.length };
    var shown = grouped.groups;

    if (headline) {
      var total = doses.length;
      var text;
      var level;
      if (counts.high === total) {
        text = total === 1
          ? 'The next dose needs extra attention.'
          : 'All ' + total + ' doses in the next 7 days need extra attention.';
        level = 'high';
      } else if (counts.high) {
        text = counts.high + ' of ' + total + ' doses in the next 7 days need extra attention.';
        level = 'high';
      } else if (counts.medium) {
        text = 'Nothing urgent. ' + counts.medium + ' ' +
          (counts.medium === 1 ? 'dose is' : 'doses are') + ' worth watching.';
        level = 'medium';
      } else {
        text = 'Nothing needs attention in the next 7 days.';
        level = 'low';
      }
      headline.textContent = text;
      headline.className = 'risk-headline ' + level;
      headline.style.display = 'block';
    }

    shown.forEach(function (dose) {
      var item = document.createElement('div');
      item.className = 'risk-item ' + dose.level;

      var when = document.createElement('div');
      when.className = 'risk-when';
      var time = document.createElement('strong');
      time.textContent = clockLabel(dose.time);
      var date = document.createElement('span');
      date.textContent = dose.count > 1
        ? 'On ' + dose.count + ' days'
        : riskDateLabel(dose.exampleDate || dose.date);
      when.appendChild(time);
      when.appendChild(date);

      var body = document.createElement('div');
      body.className = 'risk-body';

      var line = document.createElement('div');
      line.className = 'risk-line';
      var name = document.createElement('span');
      name.className = 'risk-name';
      name.textContent = (dose.medName || 'Medicine') + ' · box slot ' + (dose.compartment || '1');
      var probability = document.createElement('span');
      probability.className = 'risk-prob';
      var band = document.createElement('span');
      band.textContent = probabilityBand(dose.probability);
      var pct = document.createElement('span');
      pct.className = 'pct';
      pct.textContent = Math.round(dose.probability * 100) + '%';
      probability.appendChild(band);
      probability.appendChild(pct);
      line.appendChild(name);
      line.appendChild(probability);

      var bar = document.createElement('div');
      bar.className = 'risk-bar';
      var fill = document.createElement('i');
      fill.style.width = Math.round(dose.probability * 100) + '%';
      bar.appendChild(fill);

      var reasons = document.createElement('div');
      reasons.className = 'risk-reasons';
      reasons.textContent = dose.level === 'low'
        ? 'Recent pattern for this dose looks steady.'
        : (R.explainRisk ? R.explainRisk(dose) : 'Based on the recent dose pattern.');

      var action = document.createElement('div');
      action.className = 'risk-action';
      action.textContent = riskAction(dose);

      body.appendChild(line);
      body.appendChild(bar);
      body.appendChild(reasons);
      body.appendChild(action);
      item.appendChild(when);
      item.appendChild(body);
      list.appendChild(item);
    });

    if (note && shown.length < grouped.total) {
      note.textContent += ' Showing the ' + shown.length +
        ' highest-risk schedule patterns of ' + grouped.total + '.';
    }
  }

  // --- CSV export -----------------------------------------------------------------

  function exportCSV() {
    if (!state.lastResult) return;
    var blob = new Blob([A.toCSV(state.lastResult)], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'smartmed-adherence-' + state.lastResult.window.from +
                 '-to-' + state.lastResult.window.to + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // --- Orchestration --------------------------------------------------------------

  function paint() {
    if (!A || typeof Chart === 'undefined') return;

    var result = A.analyse(state.history, state.schedules, state.windowDays);
    state.lastResult = result;

    var subtitle = el('analytics-subtitle');
    if (subtitle) {
      subtitle.textContent = 'Dose patterns from ' +
        result.window.from + ' to ' + result.window.to + '.';
    }

    renderSimBanner(state.history);
    renderTiles(result.summary);
    renderTrend(result);
    renderRisk();
    renderHeatmap(result.heatmap);
    renderFacts(result);
    renderMethods(result);
  }

  function wire() {
    if (wired) return;
    wired = true;

    var sw = el('window-switch');
    if (sw) {
      sw.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-days]');
        if (!btn) return;
        state.windowDays = +btn.dataset.days;
        Array.prototype.forEach.call(sw.querySelectorAll('button'), function (b) {
          b.classList.toggle('active', b === btn);
        });
        paint();
      });
    }

    var exportBtn = el('export-csv-btn');
    if (exportBtn) exportBtn.addEventListener('click', exportCSV);
  }

  global.SmedAnalyticsUI = {
    render: function (history, schedules) {
      wire();
      state.history = history;
      state.schedules = schedules;
      paint();
    },
    getWindowDays: function () { return state.windowDays; }
  };
})(window);
