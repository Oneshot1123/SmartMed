/* 
  SmartMed RTC Rescue Utility
  Use this ONLY if you see "45:162" numbers on your screen.
*/

#include <Wire.h>
#include <RTClib.h>

RTC_DS3231 rtc;

void setup() {
  Serial.begin(115200);
  Wire.begin();
  delay(1000);

  Serial.println("\n--- RTC RESCUE MISSION ---");

  if (!rtc.begin()) {
    Serial.println("CRITICAL ERROR: RTC Chip Not Found.");
    Serial.println("Check: SDA=21, SCL=22.");
    while (1);
  }

  // Check if oscillator has stopped
  if (rtc.lostPower()) {
    Serial.println("Status: RTC Lost Power (OSF flag detected).");
  }

  // Force-setting a valid BCD-compatible time
  Serial.println("Action: Wiping registers with fresh time data...");
  rtc.adjust(DateTime(2026, 3, 4, 12, 0, 0)); 
  
  delay(500);
  
  // Verify with a fresh read
  DateTime now = rtc.now();
  int h = now.hour();
  int m = now.minute();
  int s = now.second();

  Serial.print("Verification: Current Time -> ");
  Serial.print(h);
  Serial.print(":");
  Serial.print(m);
  Serial.print(":");
  Serial.println(s);

  if (h < 24 && m < 60 && s < 60) {
    Serial.println("------------------------------------");
    Serial.println("SUCCESS! The clock memory is now CLEAN.");
    Serial.println("You can now upload the main SmartMedicineBox code.");
    Serial.println("------------------------------------");
  } else {
    Serial.println("------------------------------------");
    Serial.println("WARNING: THE TIME IS STILL GARBAGE.");
    Serial.println("This is 100% a Hardware issue:");
    Serial.println("1. Check if the CR2032 battery on the RTC is loose.");
    Serial.println("2. Ensure GND on RTC is connected directly to ESP32 GND.");
    Serial.println("3. Ensure VCC is 3.3V or 5V (stable).");
    Serial.println("------------------------------------");
  }
}

void loop() {}
