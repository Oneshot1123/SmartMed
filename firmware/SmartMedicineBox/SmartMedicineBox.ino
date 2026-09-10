#include <WiFi.h>
#include <Firebase_ESP_Client.h>
#include <Wire.h>
#include <RTClib.h>
#include <LiquidCrystal_I2C.h> // I2C LCD Library
#include <Preferences.h>      // Storage for UID
#include <WebServer.h>        // Portal for setup
#include "time.h" 

#include "addons/TokenHelper.h"
#include "addons/RTDBHelper.h"

// ----------------------------------------------------------------------------
// 1. CONFIGURATION
// ----------------------------------------------------------------------------
LiquidCrystal_I2C lcd(0x27, 16, 2); 
RTC_DS3231 rtc;

const int ir1Pin = 32, ir2Pin = 16, ir3Pin = 17, buzzerPin = 13;
const int greenLed = 18, yellowLed = 19, redLed = 23;

#define WIFI_SSID "Jaineel"
#define WIFI_PASSWORD "12345678"
#define API_KEY "AIzaSyDzGt90UApRGj30sj7tNqCAbsfZO2g6358"
#define DATABASE_URL "https://smartmed-grp27-default-rtdb.asia-southeast1.firebasedatabase.app"
#define USER_EMAIL "dr@example.com"
#define USER_PASSWORD "password123"

const char* ntpServer = "pool.ntp.org";
const long  gmtOffset_sec = 19800; // India
const int   daylightOffset_sec = 0;

FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

struct Schedule {
  String date; 
  String medName;
  int hour, minute, compartment;
  bool active;
  String frequency; // "once" or "daily"
};

#define MAX_SCHEDULES 15
Schedule schedules[MAX_SCHEDULES];
int activeScheduleCount = 0;
String patientID = "WUUFF3RHmJOUUZaScmTG3kwLQ5T2"; // Hardcoded default for immediate sync

Preferences preferences;
WebServer server(80);

void handlePortal() {
  String html = "<html><body style='font-family:sans-serif; background:#0f172a; color:white; padding:2rem; text-align:center;'>";
  html += "<h2 style='color:#22d3ee;'>SmartMed Configuration</h2>";
  html += "<p>Enter your Dashboard UID to pair this device:</p>";
  html += "<form action='/save' method='POST'>";
  html += "<input type='text' name='uid' placeholder='UID (e.g. KdFWZjnz)' style='padding:10px; border-radius:5px; border:none; width:80%;'>";
  html += "<br><br><button type='submit' style='padding:10px 20px; background:#10b981; color:white; border:none; border-radius:5px; cursor:pointer;'>Pair Device</button>";
  html += "</form></body></html>";
  server.send(200, "text/html", html);
}

void handleSave() {
  if (server.hasArg("uid")) {
    String newUID = server.arg("uid");
    preferences.begin("smartmed", false);
    preferences.putString("uid", newUID);
    preferences.end();
    server.send(200, "text/html", "<html><body style='font-family:sans-serif; background:#0f172a; color:white; padding:2rem; text-align:center;'><h2>Success!</h2><p>Device paired with UID: " + newUID + "</p><p>Rebooting...</p></body></html>");
    delay(2000);
    ESP.restart();
  }
}

void enterConfigMode() {
  WiFi.softAP("SmartMed-Config", "12345678");
  lcd.clear(); lcd.print("SETUP MODE");
  lcd.setCursor(0,1); lcd.print("WiFi: SmartMed");
  Serial.println("AP Mode: SmartMed-Config | 192.168.4.1");
  
  server.on("/", handlePortal);
  server.on("/save", handleSave);
  server.begin();
  
  while (true) {
    server.handleClient();
    delay(10);
  }
}

enum SystemState { IDLE, REMINDER_ACTIVE };
SystemState currentState = IDLE;
unsigned long monitoringStartTime = 0;
const unsigned long MONITORING_DURATION = 60000;
int activeCompartment = -1;
// Copy (not an index) of the schedule that fired. fetchSchedules() rewrites schedules[]
// every 30s, which can happen inside the 60s monitoring window -- an index would go stale.
Schedule activeSchedule;
int lastAlarmHour = -1;
int lastAlarmMinute = -1;

// A dose logged Missed at the alarm can still be taken late. Remember it per compartment
// (index 1-3) so a later hand in that compartment logs "Taken" with its true delaySec --
// otherwise every dose over 60 s late is a miss and timing adherence can never differ
// from taking adherence.
// ponytail: fixed 3 h late window, tune LATE_WINDOW_MS to the regimen
const unsigned long LATE_WINDOW_MS = 3UL * 3600UL * 1000UL;
Schedule lateSched[4];
unsigned long lateSince[4] = {0, 0, 0, 0};
bool latePending[4] = {false, false, false, false};

// Prototypes
void triggerHardwareTest();
void fetchSchedules();
void reportStatus(String status, const Schedule &s);
void sendHeartbeat();
bool isHandDetected(int comp);
time_t currentEpoch();

bool isHandDetected(int comp) {
  if (comp == 1) return digitalRead(ir1Pin) == LOW; 
  if (comp == 2) return digitalRead(ir2Pin) == LOW;
  if (comp == 3) return digitalRead(ir3Pin) == LOW;
  return false;
}

// Wall-clock epoch (seconds). NTP when available, RTC otherwise.
// Never millis() -- that is uptime, which cannot be compared across reboots.
time_t currentEpoch() {
  time_t now = time(nullptr);
  if (now > 1600000000) return now; // sane value => NTP has synced
  return (time_t) rtc.now().unixtime();
}

void sendHeartbeat() {
  static unsigned long lastHeartbeat = 0;
  if (millis() - lastHeartbeat < 30000) return;
  lastHeartbeat = millis();
  FirebaseJson hb;
  hb.set("lastSeen", (double) currentEpoch()); // unix seconds, so the dashboard can age it
  hb.set("uptimeMs", (double) millis());
  hb.set("status", "online-i2c");
  Firebase.RTDB.updateNode(&fbdo, "patients/" + patientID + "/heartbeat", &hb);
}

// Logs one dose event. The schedule that fired is recorded alongside the outcome so the
// dashboard can compute timing adherence (see RESEARCH_BASIS.md, P2) -- without
// scheduledTime there is no way to know whether a dose was on time or three hours late.
void reportStatus(String status, const Schedule &s) {
  struct tm ti;
  char timeStr[9]; char dateStr[11];
  char isoTime[25]; char schedStr[6];
  int nowSecOfDay;

  if (getLocalTime(&ti)) {
     sprintf(timeStr, "%02d:%02d", ti.tm_hour, ti.tm_min);
     sprintf(dateStr, "%04d-%02d-%02d", ti.tm_year + 1900, ti.tm_mon + 1, ti.tm_mday);
     sprintf(isoTime, "%04d-%02d-%02dT%02d:%02d:%02dZ", ti.tm_year + 1900, ti.tm_mon + 1, ti.tm_mday, ti.tm_hour, ti.tm_min, ti.tm_sec);
     nowSecOfDay = ti.tm_hour * 3600 + ti.tm_min * 60 + ti.tm_sec;
  } else {
     DateTime now = rtc.now();
     sprintf(timeStr, "%02d:%02d", now.hour(), now.minute());
     sprintf(dateStr, "%04d-%02d-%02d", now.year(), now.month(), now.day());
     sprintf(isoTime, "%04d-%02d-%02dT%02d:%02d:%02dZ", now.year(), now.month(), now.day(), now.hour(), now.minute(), now.second());
     nowSecOfDay = now.hour() * 3600 + now.minute() * 60 + now.second();
  }

  sprintf(schedStr, "%02d:%02d", s.hour, s.minute);
  long delaySec = (long) nowSecOfDay - (long) (s.hour * 3600 + s.minute * 60);

  FirebaseJson updateData;
  updateData.set("current_status/state", status);
  updateData.set("current_status/last_updated", String(isoTime));
  Firebase.RTDB.updateNode(&fbdo, "patients/" + patientID, &updateData);

  FirebaseJson hist;
  hist.set("date", String(dateStr));
  hist.set("time", String(timeStr));
  hist.set("status", status);
  hist.set("medName", s.medName);
  hist.set("compartment", s.compartment);
  hist.set("scheduledTime", String(schedStr));
  hist.set("delaySec", (double) delaySec);
  hist.set("epoch", (double) currentEpoch());
  Firebase.RTDB.pushJSON(&fbdo, "history/" + patientID, &hist);

  Serial.print("Logged "); Serial.print(status);
  Serial.print(" for "); Serial.print(s.medName);
  Serial.print(" (due "); Serial.print(schedStr);
  Serial.print(", delay "); Serial.print(delaySec); Serial.println("s)");
}

void fetchSchedules() {
  Serial.println("\n--- [I2C SYNC START] ---");
  String path = "schedules/" + patientID;
  Serial.print("Requesting path: "); Serial.println(path);

  if (Firebase.RTDB.getJSON(&fbdo, path)) {
    String payload = fbdo.payload();
    if (payload == "null" || payload == "{}") {
       activeScheduleCount = 0;
       return;
    }

    FirebaseJson json;
    json.setJsonData(payload);
    size_t count = json.iteratorBegin();
    activeScheduleCount = 0;

    Serial.println("--- [DEEP SYNC START] ---");
    Serial.print("RAW PAYLOAD: "); Serial.println(payload);

    String key, value;
    int type = 0;
    for (size_t i = 0; i < count && activeScheduleCount < MAX_SCHEDULES; i++) {
        json.iteratorGet(i, type, key, value);
        FirebaseJson sched;
        sched.setJsonData(value);
        FirebaseJsonData jd;

        // Parse Fields
        if (sched.get(jd, "date")) schedules[activeScheduleCount].date = jd.stringValue;
        if (sched.get(jd, "medName") && jd.stringValue != "") {
          schedules[activeScheduleCount].medName = jd.stringValue;
        } else {
          continue; // Skip items with no medName
        }
        if (sched.get(jd, "time")) {
          String t = jd.stringValue; t.trim();
          if (t.length() >= 5) {
              schedules[activeScheduleCount].hour = t.substring(0, 2).toInt();
              schedules[activeScheduleCount].minute = t.substring(3, 5).toInt();
          }
        }

        if (sched.get(jd, "compartment")) {
          if (jd.typeNum == FirebaseJson::JSON_STRING) {
              schedules[activeScheduleCount].compartment = jd.stringValue.toInt();
          } else {
              schedules[activeScheduleCount].compartment = jd.intValue;
          }
        }

        schedules[activeScheduleCount].active = true;
        if (sched.get(jd, "frequency")) {
          schedules[activeScheduleCount].frequency = jd.stringValue.length() > 0 ? jd.stringValue : "once";
        } else {
          schedules[activeScheduleCount].frequency = "once";
        }
        
        Serial.print("Loaded ["); Serial.print(activeScheduleCount); Serial.print("]: ");
        Serial.print(schedules[activeScheduleCount].medName);
        Serial.print(" @ "); Serial.print(schedules[activeScheduleCount].hour);
        Serial.print(":"); Serial.print(schedules[activeScheduleCount].minute);
        Serial.print(" ("); Serial.print(schedules[activeScheduleCount].frequency); Serial.println(")");
        
        activeScheduleCount++;
    }
    json.iteratorEnd();
    Serial.print("--- [SYNC COMPLETE: "); Serial.print(activeScheduleCount); Serial.println(" items] ---");
    
    // Check for Hardware Test Ping
    if (fbdo.payload().indexOf("\"testHW\":\"true\"") != -1) {
      triggerHardwareTest();
      Firebase.RTDB.deleteNode(&fbdo, "patients/" + patientID + "/testHW");
    }
  } else {
    Serial.print("FETCH FAILED: "); Serial.println(fbdo.errorReason());
  }
}

void showNextDose(String d, int h, int m) {
  int nextIdx = -1;
  long minDiff = 86400; 
  
  Serial.println("\n--- [NEXT DOSE CALC] ---");
  for (int i=0; i < activeScheduleCount; i++) {
    bool dateMatch = (schedules[i].date == d || schedules[i].frequency == "daily");
    if (dateMatch) {
      long diff = (schedules[i].hour * 60 + schedules[i].minute) - (h * 60 + m);
      Serial.print("Check: "); Serial.print(schedules[i].medName); 
      Serial.print(" | Time: "); Serial.print(schedules[i].hour); Serial.print(":"); Serial.print(schedules[i].minute);
      Serial.print(" | Diff: "); Serial.println(diff);
      
      if (diff > 0 && diff < minDiff) { minDiff = diff; nextIdx = i; }
    }
  }

  lcd.setCursor(0,0);
  if (nextIdx != -1) {
    lcd.print("NEXT: "); lcd.print(schedules[nextIdx].medName.substring(0,10));
    lcd.setCursor(0,1);
    char buf[16];
    sprintf(buf, "AT %02d:%02d (C%d)", schedules[nextIdx].hour, schedules[nextIdx].minute, schedules[nextIdx].compartment);
    lcd.print(buf);
  } else {
    lcd.print("NO MORE DOSES");
    lcd.setCursor(0,1); lcd.print("AVAIL. TODAY");
  }
}

void setup() {
  Serial.begin(115200);
  
  // 0. Load UID from Preferences (fallback to hardcode)
  preferences.begin("smartmed", true);
  String storedUID = preferences.getString("uid", "");
  preferences.end();
  if (storedUID != "") {
    patientID = storedUID;
    Serial.print("Preferences UID Loaded: "); Serial.println(patientID);
  } else {
    Serial.print("Using Hardcoded UID: "); Serial.println(patientID);
  }

  // Power up I2C Pins
  Wire.begin(21, 22);
  
  // Initialize I2C LCD
  lcd.init();
  lcd.backlight();
  lcd.clear();
  lcd.print("SmartMed 2026");
  
  if (patientID == "") {
    enterConfigMode();
  }

  lcd.setCursor(0,1); lcd.print("BOOTING...");
  delay(1000);

  pinMode(ir1Pin, INPUT_PULLUP); 
  pinMode(ir1Pin, INPUT_PULLUP); // Pin stability
  pinMode(ir2Pin, INPUT_PULLUP); 
  pinMode(ir3Pin, INPUT_PULLUP);
  pinMode(buzzerPin, OUTPUT); pinMode(greenLed, OUTPUT); pinMode(yellowLed, OUTPUT); pinMode(redLed, OUTPUT);

  if (!rtc.begin()) {
    lcd.clear(); lcd.print("RTC ERROR!");
    delay(2000);
  }

  // WiFi Connection
  lcd.clear();
  lcd.print("WiFi: Connect...");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int retry = 0;
  while (WiFi.status() != WL_CONNECTED && retry < 30) { 
    delay(500); 
    Serial.print("."); 
    retry++;
  }
  
  if (WiFi.status() == WL_CONNECTED) {
    lcd.clear(); lcd.print("WiFi: ONLINE");
    lcd.setCursor(0,1); lcd.print(WiFi.localIP().toString());
    delay(1500);
  } else {
    lcd.clear(); lcd.print("WiFi: FAILED");
    delay(2000);
  }
  
  configTime(gmtOffset_sec, daylightOffset_sec, ntpServer);

  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;
  auth.user.email = USER_EMAIL;
  auth.user.password = USER_PASSWORD;

  lcd.clear(); lcd.print("Firebase: Auth...");
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);
  
  retry = 0;
  while ((auth.token.uid) == "" && retry < 20) { 
    delay(500); 
    Serial.print("F");
    retry++;
  }
  
  lcd.clear(); lcd.print("Syncing Data...");
  fetchSchedules();
}

void loop() {
  struct tm ti;
  bool timeValid = getLocalTime(&ti);
  int curH, curM, curY, curMo, curD;
  char curDate[11];

  if (timeValid) {
    curH = ti.tm_hour; curM = ti.tm_min;
    curY = ti.tm_year + 1900; curMo = ti.tm_mon + 1; curD = ti.tm_mday;
  } else {
    // Fallback to RTC
    DateTime now = rtc.now();
    curH = now.hour(); curM = now.minute();
    curY = now.year(); curMo = now.month(); curD = now.day();
  }
  sprintf(curDate, "%04d-%02d-%02d", curY, curMo, curD);
  
  sendHeartbeat();
  static unsigned long lastSync = 0;
  if (millis() - lastSync > 30000) { 
    fetchSchedules(); 
    Serial.print("Sync complete. Active Schedules: "); Serial.println(activeScheduleCount);
    lastSync = millis(); 
  }

  if (currentState == IDLE) {
    // Late doses: a hand in a compartment whose alarm already timed out
    for (int c = 1; c <= 3; c++) {
      if (!latePending[c]) continue;
      bool crossedMidnight = curH * 60 + curM < lateSched[c].hour * 60 + lateSched[c].minute;
      if (millis() - lateSince[c] > LATE_WINDOW_MS || crossedMidnight) { latePending[c] = false; continue; }
      if (isHandDetected(c)) {
        latePending[c] = false;
        digitalWrite(greenLed, HIGH);
        lcd.clear(); lcd.print("TAKEN (LATE)"); reportStatus("Taken", lateSched[c]);
        delay(3000); digitalWrite(greenLed, LOW);
      }
    }

    // Check Alerts
    for (int i=0; i < activeScheduleCount; i++) {
      bool timeMatch = (schedules[i].hour == curH && schedules[i].minute == curM);
      bool dateMatch = (schedules[i].date == curDate || schedules[i].frequency == "daily");
      bool isNewMinute = (curH != lastAlarmHour || curM != lastAlarmMinute);
      
      if (timeMatch && dateMatch && isNewMinute) {
        lastAlarmHour = curH; lastAlarmMinute = curM; // Record trigger time
        activeCompartment = schedules[i].compartment;
        activeSchedule = schedules[i];
        // A new dose from this compartment supersedes any older late one
        if (activeCompartment >= 1 && activeCompartment <= 3) latePending[activeCompartment] = false;
        currentState = REMINDER_ACTIVE;
        monitoringStartTime = millis();
        lcd.clear(); lcd.print("DUE: "); lcd.print(schedules[i].medName);
        lcd.setCursor(0,1); lcd.print("TAKE FROM C"); lcd.print(activeCompartment);
        digitalWrite(yellowLed, HIGH);
        Serial.print("Alarm Triggered for: "); Serial.println(schedules[i].medName);
        break;
      }
    }
    
    // Display Toggle
    static unsigned long lastTick = 0; static int scroll = 0;
    if (millis() - lastTick > 4000) {
      lcd.clear();
      if (scroll == 0) {
        lcd.setCursor(0,0); lcd.print(curDate);
        lcd.setCursor(0,1); char buf[16];
        sprintf(buf, "%02d:%02d (%d Sch)", curH, curM, activeScheduleCount);
        lcd.print(buf); scroll = 1;
      } else { showNextDose(String(curDate), curH, curM); scroll = 0; }
      lastTick = millis();
    }
  } else {
    // REMINDER_ACTIVE
    if ((millis() / 500) % 2 == 0) digitalWrite(buzzerPin, HIGH); else digitalWrite(buzzerPin, LOW);
    
    if (isHandDetected(activeCompartment)) {
      digitalWrite(buzzerPin, LOW); digitalWrite(yellowLed, LOW); digitalWrite(greenLed, HIGH);
      lcd.clear(); lcd.print("TAKEN!"); reportStatus("Taken", activeSchedule);
      delay(3000); digitalWrite(greenLed, LOW);
      currentState = IDLE; activeCompartment = -1;
    }

    if (millis() - monitoringStartTime > MONITORING_DURATION) {
      digitalWrite(buzzerPin, LOW); digitalWrite(yellowLed, LOW); digitalWrite(redLed, HIGH);
      lcd.clear(); lcd.print("MISSED!"); reportStatus("Missed", activeSchedule);
      if (activeCompartment >= 1 && activeCompartment <= 3) {
        lateSched[activeCompartment] = activeSchedule;
        lateSince[activeCompartment] = millis();
        latePending[activeCompartment] = true;
      }
      delay(3000); digitalWrite(redLed, LOW);
      currentState = IDLE; activeCompartment = -1;
    }
  }
}

void triggerHardwareTest() {
  lcd.clear(); lcd.print("HARDWARE TEST");
  lcd.setCursor(0,1); lcd.print("EXECUTING...");
  digitalWrite(greenLed, HIGH); digitalWrite(yellowLed, HIGH); digitalWrite(redLed, HIGH);
  digitalWrite(buzzerPin, HIGH);
  delay(1000);
  digitalWrite(greenLed, LOW); digitalWrite(yellowLed, LOW); digitalWrite(redLed, LOW);
  digitalWrite(buzzerPin, LOW);
  lcd.clear(); lcd.print("TEST COMPLETE");
  delay(1000);
}
