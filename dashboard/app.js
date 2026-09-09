// 1. FIREBASE CONFIGURATION
const firebaseConfig = {
  apiKey: "AIzaSyDHfPrQkDvJm269HAxouiOcMl5HSIW8jME",
  authDomain: "smartmedicine-68c37.firebaseapp.com",
  databaseURL: "https://smartmedicine-68c37-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "smartmedicine-68c37",
  storageBucket: "smartmedicine-68c37.firebasestorage.app",
  messagingSenderId: "480005818050",
  appId: "1:480005818050:web:ac4d5716bdc0217a531d5b",
  measurementId: "G-TPW3YY9QD4"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const db = firebase.database();
const auth = firebase.auth();

// 2. STATE & UI ELEMENTS
let adherenceChart;
let caregiverUID = null;
let patientID = null; // Currently selected patient
let currentSchedules = {};
let currentHistory = {};  // full dose-event log for the selected patient; feeds the analytics

const authView = document.getElementById('auth-view');
const dashboardView = document.getElementById('dashboard-view');
const mainContent = document.getElementById('main-content');

// 3. AUTHENTICATION FLOW & NAVIGATION
let isSignUpMode = false;
document.getElementById('toggle-signup').addEventListener('click', (e) => {
    e.preventDefault();
    isSignUpMode = !isSignUpMode;
    document.getElementById('auth-btn').textContent = isSignUpMode ? 'Register Account' : 'Initiate Session';
    document.getElementById('toggle-signup').textContent = isSignUpMode ? 'Back to Login' : 'Sign Up';
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

document.getElementById('logout-btn').addEventListener('click', () => {
    auth.signOut().then(() => {
        dashboardView.style.display = 'none';
        authView.style.display = 'flex';
        patientID = null; // Clear context
    });
});

// SPA Navigation
const navItems = document.querySelectorAll('.nav-item');
const sections = document.querySelectorAll('.content-section');

navItems.forEach(item => {
    item.addEventListener('click', (e) => {
        if (item.id === 'logout-btn') return;
        e.preventDefault();
        
        // Remove active states
        navItems.forEach(n => n.classList.remove('active'));
        sections.forEach(s => s.style.display = 'none');

        // Set active
        item.classList.add('active');
        const targetId = 'section-' + item.id.replace('nav-', '');
        document.getElementById(targetId).style.display = 'block';

        // Chart.js measures its canvas on creation. If the chart was built while this
        // section was display:none it got a zero-sized box, so repaint now that the
        // section is actually laid out.
        if (item.id === 'nav-analytics') refreshAnalytics();
    });
});

// 4. DASHBOARD INITIALIZATION
function initDashboard() {
    initChart();
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

        // Auto-select first patient if none selected
        if (!patientID && patients) {
            const firstId = Object.keys(patients)[0];
            switchPatient(firstId, patients[firstId].name);
        } else if (!patients) {
            switchPatient(null);
        }
    }, err => reportDbError('load your patient list', err));
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
        const initials = data.name.split(' ').map(n=>n[0]).join('').substring(0,2).toUpperCase();
        const borderStyle = isActive ? 'border: 2px solid var(--emerald-glow); padding: 1.4rem;' : 'border: 1px solid var(--surface-border); padding: 1.5rem;';
        
        const card = document.createElement('div');
        card.className = `card span-2`;
        card.style.cssText = `${borderStyle} cursor:pointer; transition:all 0.2s ease;`;
        card.onclick = () => switchPatient(uid, data.name);
        
        card.innerHTML = `
            <div style="display:flex; gap:2rem;">
                <div style="width:100px; height:100px; background:var(--surface-hover); border-radius:25px; display:flex; align-items:center; justify-content:center; font-size:2.5rem; font-weight:800; color:var(--emerald-heal); border:1px solid var(--surface-border);">
                    ${initials}
                </div>
                <div style="flex:1;">
                    <h2 style="font-family:'Outfit'; font-size:1.75rem; margin-bottom:0.5rem; color:${isActive ? 'var(--emerald-heal)' : 'white'};">${data.name} ${isActive ? '<span style="font-size:0.8rem; background:var(--emerald-heal); color:black; padding:2px 8px; border-radius:10px; vertical-align:middle;">ACTIVE</span>' : ''}</h2>
                    <div style="display:flex; gap:1.5rem; flex-wrap:wrap;">
                        <div><span class="vital-label">AGE</span><span style="font-weight:700;">${data.age}</span></div>
                        <div><span class="vital-label">CONDITION</span><span style="font-weight:700;">${data.condition}</span></div>
                        <div><span class="vital-label">UID</span><span style="font-weight:700; color:var(--text-muted); font-size:0.8rem; font-family:monospace;">${uid}</span></div>
                    </div>
                </div>
            </div>
            <div style="margin-top:1.5rem; padding:1rem; background:rgba(255,255,255,0.02); border-radius:12px; border:1px solid var(--surface-border);">
                <p style="font-size:0.9rem; color:var(--text-muted);">${data.notes}</p>
            </div>
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
function switchPatient(uid, name = "") {
    patientID = uid;

    // Clear existing listeners
    activeListeners.forEach(l => db.ref(l.path).off('value', l.callback));
    activeListeners = [];

    // Drop the previous patient's data so nothing bleeds into the new patient's analytics
    currentHistory = {};
    currentSchedules = {};
    refreshAnalytics();

    // Clear UI Data
    if (!uid) {
        document.getElementById('patient-name-top').textContent = "No Patient Selected";
        document.getElementById('patient-subtitle').textContent = "Please add a patient.";
        document.getElementById('device-pairing-uid').textContent = "Select a patient first";
        return;
    }

    document.getElementById('patient-name-top').textContent = name;
    document.getElementById('patient-subtitle').textContent = `Currently monitoring adherence for ${name}`;
    document.getElementById('device-pairing-uid').textContent = uid;
    document.querySelector('.avatar').textContent = name.split(' ').map(n=>n[0]).join('').substring(0,2).toUpperCase();

    showToast(`Switched to patient: ${name}`);

    // Re-attach listeners for this specific patient
    attachRealTimeListeners();
    // Re-render patient grid to show active state
    db.ref(`caregivers/${caregiverUID}/patients`).once('value').then(snap => renderPatientsGrid(snap.val()));
}

function initChart() {
    const ctx = document.getElementById('adherenceChart').getContext('2d');
    adherenceChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Taken', 'Missed'],
            datasets: [{
                data: [0, 0],
                backgroundColor: ['#10b981', '#f43f5e'],
                borderWidth: 0,
                hoverOffset: 10
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '80%',
            plugins: {
                legend: { display: false }
            },
            animation: { animateScale: true }
        }
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
            updateFullHistoryTable(currentHistory);
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
    if (data.current_status) {
        const badge = document.getElementById('status-badge');
        const state = data.current_status.state || "Waiting";
        badge.textContent = state;
        badge.className = 'status-badge ' + state.toLowerCase();
        document.getElementById('last-updated-time').textContent = 
            data.current_status.last_updated ? data.current_status.last_updated.split('T')[1].substring(0,5) : "--:--";
    }

    // Taken/Missed are DERIVED from the event log rather than read from
    // patients/{id}/analytics. That stored counter is only ever incremented by the
    // Sim-Suite -- the firmware never touches it -- so it reads 0 for real device
    // activity. The log is the source of truth.
    updateOverallSuccess();

    if (data.profile) {
        // Only update matrix elements if they exist (they might be in the grid now)
        const pName = document.getElementById('p-name');
        if (pName) pName.textContent = data.profile.name;
    }
    
    // Inventory Prediction
    calculateRefillDate(data);
}

function calculateNextDose() {
    const nextDoseEl = document.getElementById('next-dose-time');
    if (!nextDoseEl) return;

    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    
    let nextS = null;
    let minDiff = 1440; // max minutes in day

    Object.values(currentSchedules).forEach(s => {
        const [h, m] = s.time.split(':').map(Number);
        const schedMinutes = h * 60 + m;
        const diff = schedMinutes - currentMinutes;

        if (diff > 0 && diff < minDiff) {
            minDiff = diff;
            nextS = s;
        }
    });

    if (nextS) {
        nextDoseEl.textContent = nextS.time;
        nextDoseEl.style.color = "var(--amber-caution)";
    } else {
        nextDoseEl.textContent = "None Today";
        nextDoseEl.style.color = "var(--text-muted)";
    }
}

function updateSchedulerUI(scheduleData) {
    const list = document.getElementById('active-schedules-list');
    if (!list) return;
    list.innerHTML = '';

    if (!scheduleData) {
        list.innerHTML = '<p style="color:var(--text-muted); font-size:0.8rem; text-align:center;">No active prescriptions.</p>';
        return;
    }

    Object.entries(scheduleData).forEach(([key, s]) => {
        const div = document.createElement('div');
        div.style.cssText = `background:var(--bg-primary); padding:1rem; border-radius:12px; border:1px solid var(--surface-border); display:flex; justify-content:space-between; align-items:center; border-left:4px solid var(--cyan-data);`;
        div.innerHTML = `
            <div>
                <h4 style="font-size:0.9rem;">${s.medName}</h4>
                <p style="font-size:0.75rem; color:var(--text-muted);">${s.time} | Comp ${s.compartment}</p>
            </div>
            <button onclick="deleteSchedule('${key}')" style="background:none; border:none; color:var(--rose-alert); cursor:pointer;">
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

        db.ref(`schedules/${patientID}`).push({
            medName, time, compartment,
            date: new Date().toISOString().split('T')[0],
            frequency: "daily",
            active: true
        }).then(() => {
            form.reset();
            showToast(`Schedule added for ${medName}.`);
        }).catch(err => reportDbError('add schedule', err));
    };
}

// Counts Taken/Missed straight from the event log and repaints the doughnut.
function updateOverallSuccess() {
    let taken = 0, missed = 0;
    Object.values(currentHistory || {}).forEach(log => {
        if (!log) return;
        if (log.status === 'Taken') taken++;
        else if (log.status === 'Missed') missed++;
    });

    document.getElementById('stat-taken').textContent = taken;
    document.getElementById('stat-missed').textContent = missed;
    if (adherenceChart) {
        adherenceChart.data.datasets[0].data = [taken, missed];
        adherenceChart.update();
    }
}

function calculateRefillDate(data) {
    // Doses per day comes from currentSchedules (populated from schedules/{patientID}).
    // It previously read data.schedule -- a node under patients/{id} that nothing ever
    // writes -- so this threw a TypeError on every status update and killed the card.
    const dailyDoses = Object.keys(currentSchedules || {}).length || 3;
    const pillsLeft = data.inventory ? data.inventory.count : 14; // no inventory node yet
    const daysLeft = Math.floor(pillsLeft / dailyDoses);

    document.getElementById('inv-count').textContent = pillsLeft + " Pills";
    document.getElementById('inv-fill').style.width = Math.min(pillsLeft / 30 * 100, 100) + "%";
    document.getElementById('refill-prediction').textContent = `Refill expected in ${daysLeft} days.`;
}

// Hands the raw log and regimen to the analytics layer, which does all the maths.
function refreshAnalytics() {
    if (window.SmedAnalyticsUI) {
        window.SmedAnalyticsUI.render(currentHistory, currentSchedules);
    }
    updateOverallSuccess();
}

function updateHistoryTable(historyData, containerId) {
    const tbody = document.getElementById(containerId);
    if (!tbody) return;
    tbody.innerHTML = '';
    
    if (!historyData) return;

    const logs = Object.entries(historyData)
        .map(([key, val]) => ({ id: key, ...val }))
        .sort((a, b) => b.id.localeCompare(a.id));

    logs.forEach(log => {
        const tr = document.createElement('tr');
        const statusColor = log.status === 'Taken' ? 'var(--emerald-heal)' : 'var(--rose-alert)';
        
        tr.innerHTML = `
            <td style="color: var(--text-muted); padding-left: 1rem;">${log.time}</td>
            <td style="font-weight: 700; color: ${statusColor}">● ${log.status.toUpperCase()}</td>
            <td style="color: var(--text-muted);">${log.compartment ? 'Comp ' + log.compartment : '--'}</td>
        `;
        tbody.appendChild(tr);
    });
}

// Detail column for the clinical log. Records written before the firmware started
// logging the schedule that fired have none of these fields, so it degrades gracefully.
function describeLog(log) {
    const bits = [];
    if (log.medName) bits.push(log.medName);
    if (log.scheduledTime) bits.push(`due ${log.scheduledTime}`);
    else if (log.scheduled_time) bits.push(`due ${log.scheduled_time}`);
    if (typeof log.delaySec === 'number' && log.status === 'Taken') {
        const mins = Math.round(log.delaySec / 60);
        if (mins > 0) bits.push(`${mins} min late`);
        else if (mins < 0) bits.push(`${-mins} min early`);
        else bits.push('on time');
    }
    if (log.simulated) bits.push('simulated');
    return bits.length ? bits.join(' · ') : '--';
}

function updateFullHistoryTable(historyData) {
    const tbody = document.getElementById('full-history-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    if (!historyData) return;

    const logs = Object.entries(historyData)
        .map(([key, val]) => ({ id: key, ...val }))
        .sort((a, b) => b.id.localeCompare(a.id));

    logs.forEach(log => {
        const tr = document.createElement('tr');
        const statusColor = log.status === 'Taken' ? 'var(--emerald-heal)' : 'var(--rose-alert)';
        
        tr.innerHTML = `
            <td>${log.date}</td>
            <td>${log.time}</td>
            <td style="font-weight: 700; color: ${statusColor}">${log.status}</td>
            <td style="color: var(--text-muted)">${describeLog(log)}</td>
        `;
        tbody.appendChild(tr);
    });
}

// 6. SIM-SUITE HANDLERS
function attachSimSuiteListeners() {
    const takenBtn = document.getElementById('sim-taken');
    const missedBtn = document.getElementById('sim-missed');
    const seedBtn = document.getElementById('seed-history');
    const clearBtn = document.getElementById('clear-sim');

    if (takenBtn) takenBtn.onclick = () => simulateEvent("Taken");
    if (missedBtn) missedBtn.onclick = () => simulateEvent("Missed");
    if (seedBtn) seedBtn.onclick = () => seedHistory();
    if (clearBtn) clearBtn.onclick = () => clearSimulatedData();
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

    const schedules = Object.values(currentSchedules || {});
    if (!schedules.length) {
        showToast("Add at least one schedule before seeding history.", true);
        return;
    }

    const days = Math.max(1, Math.min(180, parseInt(document.getElementById('seed-days').value, 10) || 60));
    const A = window.SmedAnalytics;
    const payload = {};
    let generated = 0;

    const today = new Date();
    for (let d = days - 1; d >= 0; d--) {
        const day = A.addDays(today, -d);
        const dateStr = A.dateKey(day);
        const isWeekend = day.getDay() === 0 || day.getDay() === 6;

        schedules.forEach(s => {
            const mins = A.timeToMinutes(s.time);
            if (mins === null) return;
            // "once" schedules only fire on their own date
            if (s.frequency !== 'daily' && s.date !== dateStr) return;
            if (s.frequency === 'daily' && s.date && dateStr < s.date) return;

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

    if (!generated) { showToast("Schedules produced no doses in that range.", true); return; }

    db.ref(`history/${patientID}`).update(payload)
        .then(() => showToast(`Seeded ${generated} simulated events across ${days} days.`))
        .catch(err => showToast("Seeding failed: " + err.message, true));
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
    const now = new Date();
    const timestamp = Math.floor(now.getTime() / 1000);
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

    // Update Status
    db.ref(`patients/${patientID}/current_status`).set({
        state: status,
        last_updated: now.toISOString()
    }).catch(err => reportDbError('update status', err));

    // No analytics counter write: Taken/Missed totals are derived from the log itself
    // (see updateOverallSuccess), so a separate counter would only drift out of sync.

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
    toast.style.cssText = `background: ${isError ? 'var(--rose-alert)' : 'var(--bg-primary)'}; color: white; padding: 15px 20px; border-radius: 8px; border-left: 4px solid ${isError ? 'red' : 'var(--emerald-heal)'}; box-shadow: 0 4px 15px rgba(0,0,0,0.3); font-size: 0.9rem; animation: slideInX 0.3s ease forwards;`;
    toast.textContent = message;
    
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.style.animation = 'fadeOut 0.3s ease forwards';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}
