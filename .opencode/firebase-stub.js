(function () {
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dateKey(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function addDays(d, n) {
    var x = new Date(d.getTime());
    x.setDate(x.getDate() + n);
    return x;
  }
  function minutes(t) {
    var p = t.split(':');
    return Number(p[0]) * 60 + Number(p[1]);
  }
  function clock(m) {
    m = Math.max(0, Math.min(1439, m));
    return pad(Math.floor(m / 60)) + ':' + pad(m % 60);
  }
  function rnd(seed) {
    var x = Math.sin(seed * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  }

  // ---- Story: patient recovering well on morning dose, slipping on the night dose ----
  var now = new Date();
  var nowMins = now.getHours() * 60 + now.getMinutes();
  var start = dateKey(addDays(now, -44)); // 45 days of data

  var PATIENT_ID = 'patient_robert';
  var profile = {
    name: 'Robert Kumar',
    age: '71',
    condition: 'Recovering after heart surgery',
    notes: 'Three daily medicines. Evening dose has been slipping lately.'
  };

  var schedules = {
    rob_s1: { medName: 'Metformin', time: '09:30', compartment: 1, date: start, frequency: 'daily', active: true },
    rob_s2: { medName: 'Ramipril', time: '15:45', compartment: 2, date: start, frequency: 'daily', active: true },
    rob_s3: { medName: 'Amlodipine', time: '21:00', compartment: 3, date: start, frequency: 'daily', active: true }
  };

  function baseline(age, slotIdx) {
    // Metformin steady ~95, Ramipril dip on weekends ~80, Amlodipine 90 decay to ~55 by today
    var day = 45 - age; // 1 = oldest, 45 = today
    var weekend = false;
    if (slotIdx === 0) {
      return age === 0 ? 0 : 0.97;
    }
    if (slotIdx === 1) {
      return 0.86;
    }
    // Amlodipine: good for the first 30 days, then a steady slide
    if (day <= 30) return 0.9;
    var slide = (day - 30) / 15; // 0 -> 1
    return 0.9 - 0.32 * slide;
  }

  function makeHistory() {
    var out = {};
    var slots = [
      { n: 'Metformin', t: 9 * 60 + 30, c: 1 },
      { n: 'Ramipril', t: 15 * 60 + 45, c: 2 },
      { n: 'Amlodipine', t: 21 * 60, c: 3 }
    ];
    for (var ageDays = 45 - 1; ageDays >= 0; ageDays--) {
      var dayOffset = 45 - ageDays; // 1 = oldest ... 45 = today
      var d = addDays(now, -ageDays);
      var key = dateKey(d);
      var isWeekend = d.getDay() === 0 || d.getDay() === 6;
      slots.forEach(function (s, i) {
        if (ageDays === 0 && s.t > nowMins) return; // today's future doses stay open
        var p = baseline(ageDays, i);
        if (isWeekend) p -= 0.15;
        var r = rnd(ageDays * 31 + i * 7 + 5);
        var taken = r < p;
        var delay = 1;
        if (taken) {
          delay = 3 + Math.floor(rnd(ageDays * 11 + i + 9) * 14);
          if (i === 2 && dayOffset > 30) delay += Math.floor(30 + 45 * rnd(ageDays * 17 + i)); // late nights drift well past the hour
        }
        var actual = Math.min(s.t + delay, 23 * 60 + 55);
        var id = 'rob_' + key.replace(/-/g, '') + '_' + s.t + '_' + i;
        out[id] = {
          date: key,
          time: clock(actual),
          status: taken ? 'Taken' : 'Missed',
          medName: s.n,
          compartment: s.c,
          scheduledTime: clock(s.t),
          delaySec: 60 * delay,
          epoch: Math.floor(new Date(key + 'T' + clock(actual) + ':00').getTime() / 1000),
          simulated: true
        };
      });
    }
    return out;
  }

  var store = {};
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function getPath(path) {
    var node = store[path];
    return node == null ? null : clone(node);
  }
  function setPath(path, value) {
    if (value == null) delete store[path];
    else store[path] = clone(value);
  }

  store['caregivers/test-uid/patients'] = {};
  store['caregivers/test-uid/patients'][PATIENT_ID] = profile;
  store['patients/' + PATIENT_ID] = {
    profile: profile,
    current_status: { state: 'Taken', last_updated: now.toISOString() }
  };
  store['schedules/' + PATIENT_ID] = schedules;
  store['history/' + PATIENT_ID] = makeHistory();

  var listeners = [];
  function snapshot(value) { return { val: function () { return clone(value); } }; }

  function readRef(api) {
    var val = getPath(api.path);
    if (api.limit && val && typeof val === 'object') {
      var keys = Object.keys(val).sort();
      var out = {};
      keys.slice(-api.limit).forEach(function (k) { out[k] = val[k]; });
      return out;
    }
    return val;
  }

  function ref(path) {
    var api = {
      path: path,
      limit: 0,
      limitToLast: function (n) { api.limit = n; return api; },
      on: function (event, cb) {
        listeners.push({ path: path, cb: cb });
        cb(snapshot(readRef(api)));
        return cb;
      },
      off: function () { return api; },
      once: function () { return Promise.resolve(snapshot(readRef(api))); },
      set: function (value) { setPath(path, value); return Promise.resolve(); },
      update: function (value) {
        var current = getPath(path) || {};
        Object.keys(value).forEach(function (k) { current[k] = value[k]; });
        setPath(path, current);
        return Promise.resolve();
      },
      remove: function () { setPath(path, null); return Promise.resolve(); },
      push: function () { return { key: 'auto_' + Math.random().toString(36).slice(2) }; }
    };
    return api;
  }

  var user = { uid: 'test-uid', email: 'caregiver@example.com' };
  var auth = {
    signInWithEmailAndPassword: function () { return Promise.resolve({ user: user }); },
    createUserWithEmailAndPassword: function () { return Promise.resolve({ user: user }); },
    signOut: function () { return Promise.resolve(); },
    onAuthStateChanged: function () {}
  };

  window.firebase = {
    initializeApp: function () {},
    database: function () { return { ref: ref }; },
    auth: function () { return auth; }
  };
})();
