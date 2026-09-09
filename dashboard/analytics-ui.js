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

    var labels = rows.map(function (r) { return r.date; });
    var showPoints = rows.length <= 31;

    var data = {
      labels: labels,
      datasets: [
        {
          label: 'Taking',
          data: rows.map(function (r) { return r.takingPct; }),
          borderColor: COLOR_TAKING,
          backgroundColor: COLOR_TAKING,
          borderWidth: 2,
          pointRadius: showPoints ? 4 : 0,
          pointHoverRadius: 6,
          tension: 0.25
        },
        {
          label: 'Timing',
          data: rows.map(function (r) { return r.timingPct; }),
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
      ]
    };

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
      '</div>';
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
    existing.textContent = 'This window includes ' + count +
      ' simulated event' + (count === 1 ? '' : 's') +
      ' seeded from the Sim-Suite. Clear them before reporting real adherence.';
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
      subtitle.textContent = 'Implementation-phase adherence, ' +
        result.window.from + ' to ' + result.window.to;
    }

    renderSimBanner(state.history);
    renderTiles(result.summary);
    renderTrend(result);
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
