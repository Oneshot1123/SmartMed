/* 
  SmartMed MASTER HARDWARE DIAGNOSTIC
  Use this to test EVERY physical component without WiFi/Firebase.
*/

#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <RTClib.h>

// Pins as per latest Hardware Pinout
const int IR1_PIN = 32;     // Relocated from 4
const int IR2_PIN = 16;
const int IR3_PIN = 17;
const int GREEN_LED = 18;
const int YELLOW_LED = 19;
const int RED_LED = 23;
const int BUZZER_PIN = 13;

LiquidCrystal_I2C lcd(0x27, 16, 2);
RTC_DS3231 rtc;

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n=== SMARTMED HARDWARE MASTER TEST ===");

  // Pin Modes
  pinMode(IR1_PIN, INPUT_PULLUP);
  pinMode(IR2_PIN, INPUT_PULLUP);
  pinMode(IR3_PIN, INPUT_PULLUP);
  pinMode(GREEN_LED, OUTPUT);
  pinMode(YELLOW_LED, OUTPUT);
  pinMode(RED_LED, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);

  // LCD Init
  Wire.begin(21, 22);
  lcd.init();
  lcd.backlight();
  lcd.clear();
  lcd.print("HARDWARE TEST");
  lcd.setCursor(0,1);
  lcd.print("SYSTEM START...");
  delay(2000);

  // RTC Check
  if (!rtc.begin()) {
    Serial.println("RTC FAILED!");
    lcd.clear(); lcd.print("RTC FAILED!");
  } else {
    Serial.println("RTC OK.");
  }
}

void loop() {
  Serial.println("\n--- NEW TEST CYCLE ---");

  // 1. LED CYCLE
  Serial.println("Testing LEDs...");
  lcd.clear(); lcd.print("LED TEST...");
  
  digitalWrite(GREEN_LED, HIGH); Serial.println("GREEN ON"); delay(500); digitalWrite(GREEN_LED, LOW);
  digitalWrite(YELLOW_LED, HIGH); Serial.println("YELLOW ON"); delay(500); digitalWrite(YELLOW_LED, LOW);
  digitalWrite(RED_LED, HIGH); Serial.println("RED ON"); delay(500); digitalWrite(RED_LED, LOW);

  // 2. BUZZER TEST
  Serial.println("Testing Buzzer...");
  lcd.clear(); lcd.print("BUZZER TEST...");
  digitalWrite(BUZZER_PIN, HIGH); delay(200); digitalWrite(BUZZER_PIN, LOW);
  delay(200);
  digitalWrite(BUZZER_PIN, HIGH); delay(200); digitalWrite(BUZZER_PIN, LOW);

  // 3. IR SENSOR STREAM (5 seconds)
  Serial.println("Streaming IR Data for 5s (Wave your hand!)...");
  lcd.clear(); 
  lcd.print("WAVE HAND NOW!");
  
  unsigned long start = millis();
  while (millis() - start < 5000) {
    int v1 = digitalRead(IR1_PIN);
    int v2 = digitalRead(IR2_PIN);
    int v3 = digitalRead(IR3_PIN);
    
    Serial.print("IR1 (D32): "); Serial.print(v1);
    Serial.print(" | IR2 (D16): "); Serial.print(v2);
    Serial.print(" | IR3 (D17): "); Serial.println(v3);
    
    lcd.setCursor(0,1);
    char buf[16];
    sprintf(buf, "S1:%d S2:%d S3:%d", v1, v2, v3);
    lcd.print(buf);
    
    delay(200);
  }

  Serial.println("Test Cycle Complete.");
  lcd.clear(); lcd.print("CYCLE DONE");
  delay(1000);
}
