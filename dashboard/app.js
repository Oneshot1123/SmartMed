// 1. FIREBASE CONFIGURATION
const firebaseConfig = {
  apiKey: "AIzaSyDzGt90UApRGj30sj7tNqCAbsfZO2g6358",
  authDomain: "smartmed-grp27.firebaseapp.com",
  databaseURL: "https://smartmed-grp27-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "smartmed-grp27",
  storageBucket: "smartmed-grp27.firebasestorage.app",
  messagingSenderId: "227295174203",
  appId: "1:227295174203:web:de82ebc105dc1c89f6061e",
  measurementId: "G-C6XHQM3V28"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const db = firebase.database();
const auth = firebase.auth();

// 2. STATE & UI ELEMENTS
let caregiverUID = null;
let patientID = null; // Currently selected patient
let currentSchedules = {};
let currentHistory = {};  // full dose-event log for the selected patient; feeds the analytics
let currentStatus = null;

const authView = document.getElementById('auth-view');
const dashboardView = document.getElementById('dashboard-view');
const mainContent = document.getElementById('main-content');

// 3. AUTHENTICATION FLOW & NAVIGATION
let isSignUpMode = false;
document.getElementById('toggle-signup').addEventListener('click', (e) => {
    e.preventDefault();
    isSignUpMode = !isSignUpMode;
    document.getElementById('auth-btn').textContent = isSignUpMode ? 'Create account' : 'Sign in';
    document.getElementById('toggle-signup').textContent = isSignUpMode ? 'Back to sign in' : 'Create one';
    document.getElementById('password').autocomplete = isSignUpMode ? 'new-password' : 'current-password';
});

document.getElementById('login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const errEl = document.getElementById('auth-error');
    errEl.style.display = 'none';

    if (isSignUpMode) {
        auth.createUserWithEmailAndPassword(email, password)
            .then(cred => handleAuthSuccess(cred.user))
            .catch(err => { errEl.style.display = 'block'; errEl.textContent = err.message; });
    } else {
        auth.signInWithEmailAndPassword(email, password)
            .then(cred => handleAuthSuccess(cred.user))
            .catch(err => { errEl.style.display = 'block'; errEl.textContent = err.message; });
    }
});

function handleAuthSuccess(user) {
    caregiverUID = user.uid;
    authView.style.display = 'none';
    dashboardView.style.display = 'flex';
    initDashboard();
    showToast("Authentication Successful");
}

function signOutUser() {
    auth.signOut().then(() => {
        dashboardView.style.display = 'none';
        authView.style.display = 'flex';
        patientID = null;
        currentStatus = null;
        currentHistory = {};
        currentSchedules = {};
        currentPatientName = '';
        window.SmedLLM.clear();
        resetExplain();
    }).catch(err => showToast('Sign out failed: ' + (err.message || err), true));
}

const logoutBtn = document.getElementById('logout-btn');
if (logoutBtn) logoutBtn.addEventListener('click', signOutUser);
const moreLogout = document.getElementById('more-logout');
if (moreLogout) moreLogout.addEventListener('click', signOutUser);

// SPA Navigation
const navItems = document.querySelectorAll('.nav-links .nav-item');
const sections = document.querySelectorAll('.content-section');

function showSection(sectionId, navId) {
    const target = document.getElementById(sectionId);
    if (!target) return;

    sections.forEach(s => {
        s.style.display = 'none';
        s.classList.remove('active');
    });
    target.style.display = 'block';
    target.classList.add('active');

    navItems.forEach(n => {
        const active = n.id === navId;
        n.classList.toggle('active', active);
        if (active) n.setAttribute('aria-current', 'page');
        else n.removeAttribute('aria-current');
    });

    if (mainContent) mainContent.scrollTop = 0;
    window.scrollTo(0, 0);
    // Chart.js gets a zero-size canvas if it is created while hidden, so rebuild
    // the report after the section has real layout.
    if (sectionId === 'section-analytics') refreshAnalytics();
}

navItems.forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        showSection('section-' + item.id.replace('nav-', ''), item.id);
    });
});

document.querySelectorAll('[data-goto]').forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();
        showSection(link.dataset.goto, link.dataset.nav || 'nav-more');
    });
});

// 4. DASHBOARD INITIALIZATION
function initDashboard() {
    attachCaregiverListeners();
    attachSchedulerListeners();
    attachAddPatientListeners();
    attachSimSuiteListeners();
}

/*
 * Surfaces a database failure instead of letting it vanish.
 *
 * Firebase rejects reads and writes silently unless you ask: .set() returns a promise
 * nobody was checking, and .on() takes a second "cancel" callback nobody was passing.
 * The most common cause is Realtime Database security rules denying access.
 */
function reportDbError(what, err) {
    const msg = (err && err.message) || String(err);
    console.error(`[SmartMed] Failed to ${what}:`, err);
    showToast(`Could not ${what}: ${msg}`, true);

    if (/permission|denied/i.test(msg)) {
        showToast(
            'Firebase is refusing access. In Firebase Console > Realtime Database > Rules, ' +
            'allow signed-in users: {"rules":{".read":"auth != null",".write":"auth != null"}}',
            true
        );
    }
}

function attachCaregiverListeners() {
    db.ref(`caregivers/${caregiverUID}/patients`).on('value', snap => {
        const patients = snap.val();
        renderPatientsGrid(patients);
        renderPatientSelect(patients);

        // Auto-select first patient if none selected
        if (!patientID && patients) {
            const firstId = Object.keys(patients)[0];
            switchPatient(firstId, patients[firstId].name);
        } else if (!patients) {
            switchPatient(null);
        }
    }, err => reportDbError('load your patient list', err));

    const explainBtn = document.getElementById('explain-btn');
    if (explainBtn) explainBtn.onclick = runExplain;
}

function renderPatientSelect(patients) {
    const select = document.getElementById('patient-select');
    if (!select) return;

    select.innerHTML = '';
    if (!patients || !Object.keys(patients).length) {
        const option = document.createElement('option');
        option.textContent = 'No person added yet';
        select.appendChild(option);
        select.disabled = true;
        return;
    }

    select.disabled = false;
    Object.entries(patients).forEach(([uid, data]) => {
        const option = document.createElement('option');
        option.value = uid;
        option.dataset.name = data.name || 'this person';
        option.textContent = data.name || 'Unnamed person';
        select.appendChild(option);
    });
    if (patientID && patients[patientID]) select.value = patientID;

    select.onchange = () => {
        const option = select.options[select.selectedIndex];
        switchPatient(select.value, option ? option.dataset.name : '');
    };
}

function renderPatientsGrid(patients) {
    const grid = document.getElementById('patients-grid');
    grid.innerHTML = '';
    if (!patients) {
        grid.innerHTML = '<p style="color:var(--text-muted); grid-column:span 2;">No patients registered. Add one to begin.</p>';
        return;
    }

    Object.entries(patients).forEach(([uid, data]) => {
        const isActive = uid === patientID;
        const displayName = data.name || 'Unnamed person';
        const initials = displayName.split(' ').map(n=>n[0]).join('').substring(0,2).toUpperCase();
        const borderStyle = isActive ? 'border: 2px solid var(--emerald-heal); padding: 1.4rem;' : 'border: 1px solid var(--surface-border); padding: 1.5rem;';
        
        const card = document.createElement('div');
        card.className = `card span-2`;
        card.style.cssText = `${borderStyle} cursor:pointer; transition:all 0.2s ease;`;
        card.onclick = () => switchPatient(uid, displayName);

        card.innerHTML = `
            <div style="display:flex; gap:1.25rem; align-items:center; flex-wrap:wrap;">
                <div style="width:72px; height:72px; background:var(--surface-hover); border-radius:20px; display:flex; align-items:center; justify-content:center; font-size:1.75rem; font-weight:800; color:var(--emerald-heal); border:1px solid var(--surface-border);">
                    ${initials}
                </div>
                <div style="flex:1; min-width:200px;">
                    <h2 style="font-family:'Outfit'; font-size:1.35rem; margin-bottom:0.35rem; color:${isActive ? 'var(--emerald-heal)' : 'var(--text-primary)'};">${displayName} ${isActive ? '<span class="active-tag">Selected</span>' : ''}</h2>
                    <div style="display:flex; gap:1.25rem; flex-wrap:wrap;">
                        <div><span class="vital-label">AGE</span><span style="font-weight:700;">${data.age || '--'}</span></div>
                        <div><span class="vital-label">CONDITION</span><span style="font-weight:700;">${data.condition || '--'}</span></div>
                    </div>
                </div>
            </div>
            <p class="muted patient-note">${data.notes || ''}</p>
        `;
        grid.appendChild(card);
    });
}

function attachAddPatientListeners() {
    const btn = document.getElementById('add-patient-btn');
    const formContainer = document.getElementById('add-patient-form-container');
    const cancelBtn = document.getElementById('cancel-add-patient');
    const form = document.getElementById('new-patient-form');

    btn.onclick = () => formContainer.style.display = 'block';
    cancelBtn.onclick = () => formContainer.style.display = 'none';

    form.onsubmit = (e) => {
        e.preventDefault();
        const newUID = db.ref().push().key + db.ref().push().key.substring(0,8); // Generate ~28 char UID
        const name = document.getElementById('new-p-name').value;
        const payload = {
            name: name,
            age: document.getElementById('new-p-age').value,
            condition: document.getElementById('new-p-condition').value,
            notes: document.getElementById('new-p-notes').value
        };

        // Wait for all three writes before claiming success. Previously this reported
        // "added successfully" synchronously, so a rejected write (bad security rules,
        // no network) still showed a success toast and then silently did nothing.
        Promise.all([
            db.ref(`caregivers/${caregiverUID}/patients/${newUID}`).set(payload),
            db.ref(`patients/${newUID}/profile`).set(payload),
            db.ref(`patients/${newUID}/current_status`).set({ state: "Waiting", last_updated: new Date().toISOString() })
        ]).then(() => {
            form.reset();
            formContainer.style.display = 'none';
            showToast(`Patient ${name} added successfully!`);
        }).catch(err => reportDbError('add patient', err));
    };
}

let activeListeners = [];
let currentPatientName = '';
function switchPatient(uid, name = "") {
    patientID = uid;

    // Clear existing listeners
    activeListeners.forEach(l => db.ref(l.path).off('value', l.callback));
    activeListeners = [];

    // Drop the previous patient's data so nothing bleeds into the new patient's analytics
    currentHistory = {};
    currentSchedules = {};
    currentStatus = null;
    const historyBody = document.getElementById('history-body');
    if (historyBody) historyBody.innerHTML = '';
    SmedLLM.clear();
    resetExplain();
    refreshAnalytics();

    if (!uid) {
        currentPatientName = '';
        document.getElementById('patient-subtitle').textContent = "Add someone you care for to begin.";
        document.getElementById('device-pairing-uid').textContent = "Select a person first";
        return;
    }

    const displayName = name || 'this person';
    currentPatientName = displayName;
    document.getElementById('patient-subtitle').textContent = `A simple view of ${displayName}'s medicines and box.`;
    document.getElementById('device-pairing-uid').textContent = uid;
    const select = document.getElementById('patient-select');
    if (select) select.value = uid;

    showToast(`Showing ${displayName}`);

    // Re-attach listeners for this specific patient
    attachRealTimeListeners();
    // Re-render both lists so the selected person is marked
    db.ref(`caregivers/${caregiverUID}/patients`).once('value').then(snap => {
        const patients = snap.val();
        renderPatientsGrid(patients);
        renderPatientSelect(patients);
    });
}

// 5. REAL-TIME DATA SYNC
function attachRealTimeListeners() {
    if (!patientID) return;

    const listeners = [
        { path: `patients/${patientID}`, cb: snap => { if(snap.val()) updateDashboardUI(snap.val()); } },
        { path: `history/${patientID}`, cb: snap => updateHistoryTable(snap.val(), 'history-body'), query: ref => ref.limitToLast(5) },
        { path: `history/${patientID}`, cb: snap => {
            currentHistory = snap.val() || {};
            refreshAnalytics();
        }},
        { path: `schedules/${patientID}`, cb: snap => {
            currentSchedules = snap.val() || {};
            updateSchedulerUI(currentSchedules);
            calculateNextDose();
            refreshAnalytics();
        }}
    ];

    listeners.forEach(l => {
        const ref = l.query ? l.query(db.ref(l.path)) : db.ref(l.path);
        const callback = ref.on('value', l.cb, err => reportDbError(`read ${l.path}`, err));
        activeListeners.push({ path: l.path, callback });
    });
}

function updateDashboardUI(data) {
    if (!data) return;
    if (data.current_status) currentStatus = data.current_status;
    // Taken/missed are derived from the event log, never from stored counters.
    renderToday();
}

function formatTimeString(value) {
    if (!value) return '--:--';
    const parts = String(value).split(':');
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return value;
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatStamp(value) {
    if (!value) return '--';
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.toLocaleString([], {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit'
    });
}

function formatDateKey(key) {
    if (!key) return '';
    return SmedAnalytics.parseDateKey(key).toLocaleDateString(undefined,
        { day: 'numeric', month: 'short', year: 'numeric' });
}

function logDate(log) {
    if (!log || !log.date) return null;
    const d = SmedAnalytics.parseDateKey(log.date);
    const mins = SmedAnalytics.timeToMinutes(log.time);
    if (mins != null) d.setMinutes(mins);
    return d;
}

function latestLog() {
    let latest = null;
    let latestKey = '';
    Object.values(currentHistory || {}).forEach(log => {
        if (!log || !log.date) return;
        const key = log.date + 'T' + (log.time || '00:00');
        if (!latest || key > latestKey) {
            latest = log;
            latestKey = key;
        }
    });
    return latest;
}

function calculateNextDose() {
    const nextDoseEl = document.getElementById('next-dose-time');
    if (!nextDoseEl) return;

    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    let nextS = null;
    let minDiff = 1440; // max minutes in day

    Object.values(currentSchedules).forEach(s => {
        if (!s || !s.time) return;
        // A prescribed course that has already run out produces no more doses.
        const sEndDate = SmedAnalytics.scheduleEndDate(s);
        if (sEndDate && SmedAnalytics.dateKey(now) > sEndDate) return;
        const schedMinutes = SmedAnalytics.timeToMinutes(s.time);
        if (schedMinutes == null) return;
        const diff = schedMinutes - currentMinutes;

        if (diff > 0 && diff < minDiff) {
            minDiff = diff;
            nextS = s;
        }
    });

    const medEl = document.getElementById('next-dose-med');
    const noteEl = document.getElementById('next-dose-note');

    if (nextS) {
        nextDoseEl.textContent = formatTimeString(nextS.time);
        nextDoseEl.className = 'next-dose-time';
        if (medEl) medEl.textContent = nextS.medName || 'Medicine';
        if (noteEl) noteEl.textContent = 'Box slot ' + (nextS.compartment || '1');
    } else {
        nextDoseEl.textContent = "Done for today";
        nextDoseEl.className = 'next-dose-time done';
        if (medEl) medEl.textContent = Object.keys(currentSchedules || {}).length
            ? 'All doses for today have passed.'
            : 'No medicine scheduled.';
        if (noteEl) noteEl.textContent = '';
    }
}

function renderToday() {
    if (!window.SmedAnalytics) return;
    const A = window.SmedAnalytics;
    const now = new Date();
    const todayKey = A.dateKey(now);
    const nowMins = now.getHours() * 60 + now.getMinutes();

    const row = A.buildDailyTable(currentHistory, currentSchedules, todayKey, todayKey, null, nowMins)[0];
    const assignments = (row && row.assignments) || [];
    const prescribed = (A.expandPrescribed(currentSchedules, todayKey, todayKey)[todayKey]) || [];

    const taken = row ? row.N : 0;
    const missed = assignments.filter(a => !a.event).length;
    const later = Math.max(0, prescribed.length - assignments.length);

    const takenEl = document.getElementById('today-taken');
    const missedEl = document.getElementById('today-missed');
    const laterEl = document.getElementById('today-later');
    if (takenEl) takenEl.textContent = taken;
    if (missedEl) missedEl.textContent = missed;
    if (laterEl) laterEl.textContent = later;

    const list = document.getElementById('today-doses');
    if (list) {
        list.innerHTML = '';
        if (!prescribed.length) {
            const p = document.createElement('p');
            p.className = 'empty-state';
            p.textContent = 'No medicines scheduled yet. Add one on the Medicines page.';
            list.appendChild(p);
        } else {
            prescribed.forEach(slot => {
                const assignment = assignments.find(a => a.slot.id === slot.id);
                let label = 'Later';
                let cls = 'pending';
                if (assignment && assignment.event) {
                    label = 'Taken';
                    cls = 'taken';
                } else if (assignment) {
                    label = 'No record';
                    cls = 'missed';
                }

                const item = document.createElement('div');
                item.className = 'dose-row';
                const time = document.createElement('span');
                time.className = 'dose-time';
                time.textContent = formatTimeString(slot.time);
                const med = document.createElement('span');
                med.className = 'dose-med';
                med.textContent = slot.medName + ' · slot ' + (slot.compartment || '1');
                const chip = document.createElement('span');
                chip.className = 'dose-chip ' + cls;
                chip.textContent = label;
                item.appendChild(time);
                item.appendChild(med);
                item.appendChild(chip);
                list.appendChild(item);
            });
        }
    }

    const week = A.analyse(currentHistory, currentSchedules, 7);
    const taking = week.summary.taking.value;
    const weekValue = document.getElementById('week-taking');
    const weekCaption = document.getElementById('week-caption');
    const weekFill = document.getElementById('week-fill');
    const weekNumbers = document.getElementById('week-numbers');
    if (weekValue) weekValue.textContent = taking == null ? '--' : Math.round(taking) + '%';
    if (weekCaption) {
        weekCaption.textContent = taking == null
            ? 'No doses recorded yet.'
            : 'of scheduled doses taken this week';
    }
    if (weekFill) weekFill.style.width = (taking == null ? 0 : taking) + '%';
    if (weekNumbers) {
        weekNumbers.textContent = week.summary.totalPrescribed
            ? week.summary.totalTaken + ' taken · ' + week.summary.totalMissed + ' no record'
            : 'No scheduled doses this week.';
    }

    const latest = latestLog();
    const boxStatus = document.getElementById('box-status');
    const lastUpdated = document.getElementById('last-updated-time');

    if (!latest) {
        if (boxStatus) {
            boxStatus.className = 'box-status checking';
            boxStatus.textContent = currentStatus && currentStatus.last_updated
                ? 'Waiting for first dose'
                : 'No data yet';
        }
        if (lastUpdated) {
            lastUpdated.textContent = currentStatus && currentStatus.last_updated
                ? formatStamp(currentStatus.last_updated)
                : '--';
        }
        return;
    }

    const latestDate = logDate(latest);
    const today = A.parseDateKey(todayKey);
    const daysSince = latestDate ? Math.round((today - A.parseDateKey(latest.date)) / 86400000) : null;
    const staleAfter = (window.SmedRisk && window.SmedRisk.staleAfterDays) || 3;

    if (boxStatus) {
        const stale = daysSince != null && daysSince > staleAfter;
        boxStatus.className = 'box-status ' + (stale ? 'warning' : 'ok');
        boxStatus.textContent = stale ? 'Check the box' : 'Box connected';
    }
    if (lastUpdated) lastUpdated.textContent = latestDate ? formatStamp(latestDate) : '--';
}

/*
 * Compact per-patient summary for the Groq explainer. Built from the same
 * analytics calls the cards use, so the LLM can only describe numbers the
 * caregiver can already see on screen.
 * ponytail: passes top 3 risk doses; an LLM prompt survives on a small payload.
 */
function buildExplainStats() {
    const A = window.SmedAnalytics;
    if (!A || !patientID) return null;

    const now = new Date();
    const todayKey = A.dateKey(now);
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const row = A.buildDailyTable(currentHistory, currentSchedules, todayKey, todayKey, null, nowMins)[0];
    const assignments = (row && row.assignments) || [];
    const prescribedToday = (A.expandPrescribed(currentSchedules, todayKey, todayKey)[todayKey]) || [];
    const week = A.analyse(currentHistory, currentSchedules, 7).summary;

    const stats = {
        patient: currentPatientName || 'the patient',
        today: {
            scheduled: prescribedToday.length,
            taken: row ? row.N : 0,
            missed: assignments.filter(a => !a.event).length
        },
        last7days: {
            scheduled: week.totalPrescribed || 0,
            taken: week.totalTaken || 0,
            missed: week.totalMissed || 0,
            takingPercent: week.taking && week.taking.value == null ? null : Math.round(week.taking.value),
            timingPercent: week.timing && week.timing.value == null ? null : Math.round(week.timing.value)
        },
        medicineTimes: Object.values(currentSchedules || {})
            .filter(s => s && s.time)
            .filter(s => {
                const sEndDate = A.scheduleEndDate(s);
                return !sEndDate || A.dateKey(new Date()) <= sEndDate;
            })
            .map(s => {
                const courseDays = A.courseDays(s);
                const sEndDate = A.scheduleEndDate(s);
                const course = (courseDays != null && sEndDate)
                    ? `, prescribed for ${courseDays} days until ${sEndDate}`
                    : '';
                return `${s.medName} ${formatTimeString(s.time)} (box slot ${s.compartment || '1'})${course}`;
            })
    };

    const latest = latestLog();
    const latestDate = latest && latest.date ? A.parseDateKey(latest.date) : null;
    const daysSince = latestDate ? Math.round((new Date(todayKey + 'T00:00') - latestDate) / 86400000) : null;
    const staleAfter = (window.SmedRisk && window.SmedRisk.staleAfterDays) || 3;
    stats.box = {
        connected: !(daysSince != null && daysSince > staleAfter),
        lastEventSeen: daysSince == null ? null : (daysSince === 0 ? 'today' : daysSince + ' days ago')
    };

    if (!stats.box.connected) return stats;

    const R = window.SmedRisk;
    if (R) {
        const scored = R.scoreUpcoming(currentHistory, currentSchedules, { daysAhead: 7 });
        if (scored.dataWarning) {
            stats.dataPaused = scored.dataWarning.type;
            return stats;
        }
        stats.upcoming = (scored.top || []).slice(0, 3).map(dose => ({
            when: dose.date + ' ' + formatTimeString(dose.time),
            medicine: (dose.medName || 'Medicine') + ' (box slot ' + (dose.compartment || '1') + ')',
            chance: dose.level,
            why: R.explainRisk(dose)
        }));
    }
    return stats;
}

function resetExplain() {
    const out = document.getElementById('explain-out');
    const btn = document.getElementById('explain-btn');
    if (out) { out.style.display = 'none'; out.textContent = ''; }
    if (btn) { btn.disabled = false; btn.textContent = 'Explain in simple words'; }
}

function runExplain() {
    const btn = document.getElementById('explain-btn');
    const out = document.getElementById('explain-out');
    if (!btn || !out) return;

    btn.disabled = true;
    btn.textContent = 'Thinking...';
    window.SmedLLM.forget(patientID);
    const stats = buildExplainStats();
    window.SmedLLM.explain(patientID, stats).then(text => {
        out.textContent = text;
        out.style.display = 'block';
        const disclaimer = document.getElementById('explain-disclaimer');
        if (disclaimer) disclaimer.style.display = 'block';
        btn.textContent = 'Explain again';
        btn.disabled = false;
    }).catch(err => {
        out.textContent = (err && err.title ? err.title + ' — ' : '') + (err && err.hint || 'Something went wrong. Try again.');
        out.style.display = 'block';
        const disclaimer = document.getElementById('explain-disclaimer');
        if (disclaimer) disclaimer.style.display = 'none';
        btn.textContent = 'Try again';
        btn.disabled = false;
    });
}

function updateSchedulerUI(scheduleData) {
    const list = document.getElementById('active-schedules-list');
    if (!list) return;
    list.innerHTML = '';

    if (!scheduleData) {
        list.innerHTML = '<p class="empty-state">No medicines yet. Add one to get started.</p>';
        return;
    }

    Object.entries(scheduleData).forEach(([key, s]) => {
        const A = window.SmedAnalytics;
        const todayKey = A.dateKey(new Date());
        const courseDays = A.courseDays(s);
        const endDate = A.scheduleEndDate(s);
        const finished = endDate != null && todayKey > endDate;

        let courseLine;
        if (s.frequency === 'once') {
            courseLine = 'One-off dose' + (s.date ? ' · ' + formatDateKey(s.date) : '');
        } else if (finished) {
            courseLine = `Course finished ${formatDateKey(endDate)}`;
        } else if (courseDays != null && endDate) {
            const startKey = s.date || todayKey;
            const dayNum = Math.round((A.parseDateKey(todayKey) - A.parseDateKey(startKey)) / 86400000) + 1;
            courseLine = startKey > todayKey
                ? `Every day · ${courseDays} days from ${formatDateKey(startKey)}`
                : `Every day · day ${dayNum} of ${courseDays} · until ${formatDateKey(endDate)}`;
        } else {
            courseLine = 'Every day · ongoing until deleted';
        }

        const div = document.createElement('div');
        div.className = 'schedule-item' + (finished ? ' finished' : '');
        div.innerHTML = `
            <div>
                <h3>${s.medName}${finished ? ' <span class="finished-tag">Finished</span>' : ''}</h3>
                <p class="muted">${formatTimeString(s.time)} · slot ${s.compartment || '1'} · ${courseLine}</p>
            </div>
            <button type="button" class="icon-button" onclick="deleteSchedule('${key}')" aria-label="Remove ${s.medName}">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/></svg>
            </button>
        `;
        list.appendChild(div);
    });
}

window.deleteSchedule = (id) => {
    if (confirm("Delete this medication schedule?")) {
        db.ref(`schedules/${patientID}/${id}`).remove()
            .catch(err => reportDbError('delete schedule', err));
    }
};

function attachSchedulerListeners() {
    const form = document.getElementById('schedule-form');
    if (!form) return;

    form.onsubmit = (e) => {
        e.preventDefault();
        if (!patientID) {
            showToast("Please select a patient first!", true);
            return;
        }

        const medName = document.getElementById('sched-med').value;
        const time = document.getElementById('sched-time').value;
        const compartment = document.getElementById('sched-comp').value;

        // Prescribed course length: 1..365 days, blank = ongoing (doctor's long-term med).
        const rawDays = parseInt(document.getElementById('sched-days').value, 10);
        const days = isNaN(rawDays) ? null : Math.min(365, Math.max(1, rawDays));

        const record = {
            medName, time, compartment,
            date: SmedAnalytics.dateKey(new Date()), // local date; toISOString() is UTC
            frequency: "daily",
            active: true
        };
        if (days != null) record.days = days;

        db.ref(`schedules/${patientID}`).push(record).then(() => {
            form.reset();
            showToast(`Schedule added for ${medName}.`);
        }).catch(err => reportDbError('add schedule', err));
    };
}

// Hands the raw log and regimen to the analytics layer, which does all the maths.
function refreshAnalytics() {
    if (window.SmedAnalyticsUI) {
        window.SmedAnalyticsUI.render(currentHistory, currentSchedules);
    }
    renderDoseJournal(currentHistory);
    renderToday();
    calculateNextDose();
}

function sortedLogs(historyData) {
    return Object.entries(historyData)
        .map(([key, val]) => ({ id: key, ...val }))
        .sort((a, b) => {
            const ak = (a.date || '') + 'T' + (a.time || '');
            const bk = (b.date || '') + 'T' + (b.time || '');
            if (ak !== bk) return bk.localeCompare(ak);
            return String(b.id).localeCompare(String(a.id));
        });
}

function updateHistoryTable(historyData, containerId) {
    const tbody = document.getElementById(containerId);
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!historyData) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="3" class="muted">No doses recorded yet.</td>';
        tbody.appendChild(tr);
        return;
    }

    const logs = sortedLogs(historyData);

    logs.forEach(log => {
        const tr = document.createElement('tr');
        const status = log.status === 'Taken' || log.status === 'Missed' ? log.status : 'Recorded';
        const cls = status.toLowerCase();

        tr.innerHTML = `
            <td class="muted">${formatTimeString(log.time)}</td>
            <td>${log.medName || 'Medicine'}</td>
            <td><span class="result ${cls}">${status}</span></td>
        `;
        tbody.appendChild(tr);
    });
}

const JOURNAL_DAYS = 14;

/*
 * History as a day -> morning/afternoon/night -> medicine accordion.
 *
 * Native <details> keeps this cheap: the browser handles open/close, keyboard and
 * screen-reader behaviour, so no toggle state lives in JS. Only the latest day starts
 * open. Data comes from the same buildDailyTable pipeline the rest of the dashboard
 * uses, so the chips here always match the Today card and the Reports numbers.
 */
function periodForMinutes(mins) {
    if (mins < 12 * 60) return 'Morning';
    if (mins < 18 * 60) return 'Afternoon';
    return 'Night';
}

function renderDoseJournal(historyData) {
    const host = document.getElementById('history-accordion');
    if (!host) return;
    host.innerHTML = '';

    if (!historyData || !window.SmedAnalytics) {
        const p = document.createElement('p');
        p.className = 'empty-state';
        p.textContent = 'No doses recorded yet. Once the box sends events they appear here by day.';
        host.appendChild(p);
        return;
    }

    const A = window.SmedAnalytics;
    const today = new Date();
    const todayKey = A.dateKey(today);
    const nowMins = today.getHours() * 60 + today.getMinutes();
    const fromKey = A.dateKey(A.addDays(today, -(JOURNAL_DAYS - 1)));
    const rows = A.buildDailyTable(historyData, currentSchedules, fromKey, todayKey, null,
        todayKey === A.dateKey(today) ? nowMins : null);

    rows.slice().reverse().forEach(row => {
        if (!row.assignments.length) return;

        const day = document.createElement('details');
        day.className = 'journal-day';
        if (!host.childElementCount) day.open = true;

        const summary = document.createElement('summary');
        const dayLabel = document.createElement('strong');
        dayLabel.textContent = A.parseDateKey(row.date).toLocaleDateString(undefined,
            { weekday: 'short', day: 'numeric', month: 'short' });
        const dayMeta = document.createElement('span');
        const taken = row.assignments.filter(a => a.event).length;
        dayMeta.textContent = `${taken} of ${row.assignments.length} taken`;
        summary.appendChild(dayLabel);
        summary.appendChild(dayMeta);
        day.appendChild(summary);

        const periods = [['Morning', []], ['Afternoon', []], ['Night', []]];
        row.assignments.forEach(a => {
            periods[periodForMinutes(a.slot.minutes) === 'Morning' ? 0
                : periodForMinutes(a.slot.minutes) === 'Afternoon' ? 1 : 2][1].push(a);
        });
        periods.forEach(([label, items]) => {
            if (!items.length) return;
            const block = document.createElement('div');
            block.className = 'journal-period';
            const title = document.createElement('h3');
            title.textContent = label;
            block.appendChild(title);

            items.forEach(a => {
                const line = document.createElement('div');
                line.className = 'dose-row';
                const time = document.createElement('span');
                time.className = 'dose-time';
                time.textContent = formatTimeString(a.slot.time);
                const med = document.createElement('span');
                med.className = 'dose-med';
                med.textContent = a.slot.medName + ' · slot ' + (a.slot.compartment || '1');
                const chip = document.createElement('span');
                chip.className = 'dose-chip';
                if (a.event) {
                    if (typeof a.deltaMin === 'number' && a.deltaMin > A.TIMING_WINDOW_MIN) {
                        chip.classList.add('late');
                        chip.textContent = 'Late';
                    } else {
                        chip.classList.add('taken');
                        chip.textContent = 'Taken';
                    }
                } else {
                    chip.classList.add('missed');
                    chip.textContent = 'No record';
                }
                line.appendChild(time);
                line.appendChild(med);
                line.appendChild(chip);
                block.appendChild(line);
            });
            day.appendChild(block);
        });
        host.appendChild(day);
    });

    if (!host.childElementCount) {
        const p = document.createElement('p');
        p.className = 'empty-state';
        p.textContent = 'No doses recorded in the last 14 days.';
        host.appendChild(p);
    }
}

// 6. SIM-SUITE HANDLERS
function attachSimSuiteListeners() {
    const takenBtn = document.getElementById('sim-taken');
    const missedBtn = document.getElementById('sim-missed');
    const seedBtn = document.getElementById('seed-history');
    const demoBtn = document.getElementById('create-demo-patient');
    const clearBtn = document.getElementById('clear-sim');

    if (takenBtn) takenBtn.onclick = () => simulateEvent("Taken");
    if (missedBtn) missedBtn.onclick = () => simulateEvent("Missed");
    if (seedBtn) seedBtn.onclick = () => seedHistory();
    if (demoBtn) demoBtn.onclick = () => createDemoPatient();
    if (clearBtn) clearBtn.onclick = () => clearSimulatedData();
}

/*
 * Builds a 60-day demo patient so the full dashboard can be checked end-to-end without
 * touching a real participant. It is deliberately deterministic in structure (three
 * schedules, weekend effect, evening drift) and uses a fixed ID, so clicking again
 * refreshes the same patient instead of creating duplicates.
 */
function createDemoPatient() {
    if (!caregiverUID) { showToast("Sign in before creating the demo patient.", true); return; }

    const DEMO_ID = 'demo_patient_ml';
    const DEMO_DAYS = 60;
    const A = window.SmedAnalytics;
    const now = new Date();
    const startKey = A.dateKey(A.addDays(now, -(DEMO_DAYS - 1)));
    const profile = {
        name: 'Demo Patient',
        age: '68',
        condition: 'Hypertension',
        notes: 'Demo patient with 60 days of simulated dose events for ML verification. Safe to remove.'
    };
    const schedules = {
        demo_s1: { medName: 'Metformin', time: '08:00', compartment: 1, date: startKey, frequency: 'daily', active: true },
        demo_s2: { medName: 'Amlodipine', time: '14:00', compartment: 2, date: startKey, frequency: 'daily', active: true },
        demo_s3: { medName: 'Atorvastatin', time: '20:30', compartment: 3, date: startKey, frequency: 'daily', active: true }
    };
    const scheduleList = Object.entries(schedules).map(([key, s]) => ({ key, ...s }));
    const seed = buildSeedPayload(scheduleList, DEMO_DAYS);

    if (!seed.generated) {
        showToast("Could not generate demo events for the current time.", true);
        return;
    }

    Promise.all([
        db.ref(`caregivers/${caregiverUID}/patients/${DEMO_ID}`).set(profile),
        db.ref(`patients/${DEMO_ID}/profile`).set(profile),
        db.ref(`patients/${DEMO_ID}/current_status`).set({ state: 'Waiting', last_updated: now.toISOString() }),
        db.ref(`schedules/${DEMO_ID}`).set(schedules),
        db.ref(`history/${DEMO_ID}`).set(seed.payload)
    ]).then(() => {
        showToast(`Demo patient ready: ${seed.generated} events across ${DEMO_DAYS} days.`);
        switchPatient(DEMO_ID, profile.name);
    }).catch(err => reportDbError('create demo patient', err));
}

/*
 * Seeds synthetic dose events against the patient's real schedules.
 *
 * The generated behaviour is deliberately structured rather than uniformly random, so the
 * analytics have something real to find:
 *   - a weekend effect (adherence drops Sat/Sun)
 *   - evening drift (late-day doses are missed more often, and taken later when taken)
 *   - occasional double IR triggers, which the P2 30-minute rule must collapse
 *
 * These are the patterns Burnier (Front Pharmacol 2018;9:1540) describes electronic
 * monitoring as uniquely able to reveal. Every record is tagged `simulated: true`.
 */
function seedHistory() {
    if (!patientID) { showToast("Select a patient first!", true); return; }

    const schedules = Object.entries(currentSchedules || {}).map(([key, s]) => ({ key, ...s }));
    if (!schedules.length) {
        showToast("Add at least one schedule before seeding history.", true);
        return;
    }

    const days = Math.max(1, Math.min(180, parseInt(document.getElementById('seed-days').value, 10) || 60));
    const A = window.SmedAnalytics;
    const today = new Date();
    const startKey = A.dateKey(A.addDays(today, -(days - 1)));

    // The analytics ignore days before a schedule's start date, so history seeded before a
    // schedule created today would never be scored. Ongoing daily schedules are backdated
    // to the first seeded day, keeping the real start in seedOrigDate so "Clear simulated
    // data" can put it back. A prescribed course keeps its real dates, so simulated data
    // never falls outside the course the doctor set.
    const startUpdates = {};
    schedules.forEach(s => {
        if (s.frequency === 'daily' && A.courseDays(s) == null && (!s.date || s.date > startKey)) {
            startUpdates[`${s.key}/date`] = startKey;
            if (!s.seedOrigDate) startUpdates[`${s.key}/seedOrigDate`] = s.date || A.dateKey(today);
            s.date = startKey;
        }
    });

    const seed = buildSeedPayload(schedules, days);
    if (!seed.generated) { showToast("Schedules produced no doses in that range.", true); return; }

    Promise.all([
        db.ref(`history/${patientID}`).update(seed.payload),
        db.ref(`schedules/${patientID}`).update(startUpdates)
    ])
        .then(() => showToast(`Seeded ${seed.generated} simulated events across ${days} days.`))
        .catch(err => showToast("Seeding failed: " + err.message, true));
}

function buildSeedPayload(schedules, days) {
    const A = window.SmedAnalytics;
    const payload = {};
    let generated = 0;

    const today = new Date();
    const nowMins = today.getHours() * 60 + today.getMinutes();

    for (let d = days - 1; d >= 0; d--) {
        const day = A.addDays(today, -d);
        const dateStr = A.dateKey(day);
        const isWeekend = day.getDay() === 0 || day.getDay() === 6;

        schedules.forEach(s => {
            const mins = A.timeToMinutes(s.time);
            if (mins === null) return;
            if (d === 0 && mins > nowMins) return; // not due yet today
            // "once" schedules only fire on their own date
            if (s.frequency !== 'daily' && s.date !== dateStr) return;
            if (s.frequency === 'daily' && s.date && dateStr < s.date) return;
            // a prescribed course stops after its last day
            if (s.frequency === 'daily') {
                const sEndDate = A.scheduleEndDate(s);
                if (sEndDate && dateStr > sEndDate) return;
            }

            const isEvening = mins >= 19 * 60;
            let pTaken = 0.90;
            if (isWeekend) pTaken -= 0.12;
            if (isEvening) pTaken -= 0.15;

            const scheduledTime = A.minutesToTime(mins);
            const takenNow = Math.random() < pTaken;

            if (!takenNow) {
                addSeed(payload, dateStr, A.minutesToTime(mins + 1), "Missed", s, scheduledTime, 60);
                generated++;
                return;
            }

            // Lateness: normally a few minutes, longer in the evening, occasionally much longer.
            let delayMin = Math.round(Math.random() * 12) + (isEvening ? Math.round(Math.random() * 30) : 0);
            if (Math.random() < 0.08) delayMin += 45 + Math.round(Math.random() * 60);

            const actual = Math.min(mins + delayMin, 23 * 60 + 58);
            addSeed(payload, dateStr, A.minutesToTime(actual), "Taken", s, scheduledTime, (actual - mins) * 60);
            generated++;

            // A hand breaking the IR beam twice for one dose. P2's dedup rule collapses these.
            if (Math.random() < 0.05) {
                const repeat = Math.min(actual + 3 + Math.round(Math.random() * 5), 23 * 60 + 59);
                addSeed(payload, dateStr, A.minutesToTime(repeat), "Taken", s, scheduledTime, (repeat - mins) * 60);
                generated++;
            }
        });
    }

    return { payload, generated };
}

function addSeed(payload, dateStr, timeStr, status, schedule, scheduledTime, delaySec) {
    const key = `sim_${dateStr.replace(/-/g, '')}_${timeStr.replace(':', '')}_${Math.random().toString(36).slice(2, 7)}`;
    payload[key] = {
        date: dateStr,
        time: timeStr,
        status: status,
        medName: schedule.medName || 'Unnamed',
        compartment: Number(schedule.compartment) || 1,
        scheduledTime: scheduledTime,
        delaySec: delaySec,
        epoch: Math.floor(new Date(`${dateStr}T${timeStr}:00`).getTime() / 1000),
        simulated: true
    };
}

// Removes only the records this tool created; real device events are left untouched.
function clearSimulatedData() {
    if (!patientID) { showToast("Select a patient first!", true); return; }
    if (!confirm("Remove all simulated events for this patient? Real device events are kept.")) return;

    // Undo the start-date backdating done by seedHistory
    db.ref(`schedules/${patientID}`).once('value').then(snap => {
        const updates = {};
        Object.entries(snap.val() || {}).forEach(([k, s]) => {
            if (s && s.seedOrigDate) {
                updates[`${k}/date`] = s.seedOrigDate;
                updates[`${k}/seedOrigDate`] = null;
            }
        });
        if (Object.keys(updates).length) return db.ref(`schedules/${patientID}`).update(updates);
    }).catch(err => reportDbError('restore schedule start dates', err));

    db.ref(`history/${patientID}`).once('value').then(snap => {
        const all = snap.val() || {};
        const updates = {};
        Object.keys(all).forEach(k => {
            if (all[k] && all[k].simulated === true) updates[k] = null;
        });
        const count = Object.keys(updates).length;
        if (!count) { showToast("No simulated events to clear."); return; }
        return db.ref(`history/${patientID}`).update(updates)
            .then(() => showToast(`Removed ${count} simulated events.`));
    }).catch(err => showToast("Clear failed: " + err.message, true));
}

function simulateEvent(status) {
    if (!patientID) { showToast("Select a person first.", true); return; }
    const now = new Date();
    const timestamp = Math.floor(now.getTime() / 1000);
    const dateStr = SmedAnalytics.dateKey(now);
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

    // Update Status
    db.ref(`patients/${patientID}/current_status`).set({
        state: status,
        last_updated: now.toISOString()
    }).catch(err => reportDbError('update status', err));

    // No analytics counter write: totals are derived from the log itself, so a separate
    // counter would only drift out of sync.

    // Add History. Tagged simulated so "Clear simulated data" can find it again.
    db.ref(`history/${patientID}/log_${timestamp}`).set({
        date: dateStr,
        time: timeStr,
        scheduled_time: "Simulation",
        status: status,
        simulated: true
    }).catch(err => reportDbError('log simulated event', err));
    showToast(`Simulation sent: ${status}`);
}

// 7. UTILS
function showToast(message, isError = false) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    
    const toast = document.createElement('div');
    toast.style.cssText = `background: ${isError ? 'var(--rose-alert)' : 'var(--surface)'}; color: ${isError ? 'white' : 'var(--text-primary)'}; padding: 15px 20px; border-radius: 8px; border-left: 4px solid ${isError ? 'var(--rose-alert)' : 'var(--emerald-heal)'}; box-shadow: 0 8px 24px rgba(15,23,42,0.18); font-size: 0.9rem; animation: slideInX 0.3s ease forwards;`;
    toast.textContent = message;
    
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.style.animation = 'fadeOut 0.3s ease forwards';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}
