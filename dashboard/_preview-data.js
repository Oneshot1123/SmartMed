// Throwaway fixture that drives the Analytics section without Firebase, so the layout
// can be eyeballed. Mirrors the shape seedHistory() writes.
(function () {
  var A = window.SmedAnalytics;

  var schedules = {
    s1: { medName: 'Metformin',    time: '08:00', compartment: 1, date: '2026-01-01', frequency: 'daily' },
    s2: { medName: 'Amlodipine',   time: '14:00', compartment: 2, date: '2026-01-01', frequency: 'daily' },
    s3: { medName: 'Atorvastatin', time: '21:00', compartment: 3, date: '2026-01-01', frequency: 'daily' }
  };

  var history = {};
  var today = new Date();
  var n = 0;

  for (var d = 59; d >= 0; d--) {
    var day = A.addDays(today, -d);
    var dateStr = A.dateKey(day);
    var weekend = day.getDay() === 0 || day.getDay() === 6;

    Object.keys(schedules).forEach(function (k) {
      var s = schedules[k];
      var mins = A.timeToMinutes(s.time);
      var evening = mins >= 19 * 60;
      var p = 0.90 - (weekend ? 0.12 : 0) - (evening ? 0.15 : 0);
      var sched = A.minutesToTime(mins);
      var key = 'sim_' + (n++);

      if (Math.random() >= p) {
        history[key] = { date: dateStr, time: A.minutesToTime(mins + 1), status: 'Missed',
          medName: s.medName, compartment: s.compartment, scheduledTime: sched,
          delaySec: 60, simulated: true };
        return;
      }
      var delay = Math.round(Math.random() * 12) + (evening ? Math.round(Math.random() * 30) : 0);
      if (Math.random() < 0.08) delay += 45 + Math.round(Math.random() * 60);
      var actual = Math.min(mins + delay, 23 * 60 + 58);
      history[key] = { date: dateStr, time: A.minutesToTime(actual), status: 'Taken',
        medName: s.medName, compartment: s.compartment, scheduledTime: sched,
        delaySec: (actual - mins) * 60, simulated: true };

      if (Math.random() < 0.05) {
        history['sim_' + (n++)] = { date: dateStr, time: A.minutesToTime(actual + 4), status: 'Taken',
          medName: s.medName, compartment: s.compartment, scheduledTime: sched,
          delaySec: (actual + 4 - mins) * 60, simulated: true };
      }
    });
  }

  window.SmedAnalyticsUI.render(history, schedules);
})();
