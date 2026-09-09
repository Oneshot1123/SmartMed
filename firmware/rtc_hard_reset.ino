/* 
  SmartMed RTC Hard Reset Utility
  Use this if your clock shows weird numbers like 45:162:85.
  This will FORCE the clock to a clean state.
*/

#include <Wire.h>
#include <RTClib.h>

RTC_DS3231 rtc;

void setup() {
  Serial.begin(115200);
  Wire.begin();

  Serial.println("Starting RTC Hard Reset...");

  if (!rtc.begin()) {
    Serial.println("RTC not found! Check wiring on SDA(21) and SCL(22).");
    while (1);
  }

  // Force-setting a valid manual time to clear the BCD registers
  // Format: DateTime(Year, Month, Day, Hour, Min, Sec)
  Serial.println("Writing fresh time data...");
  rtc.adjust(DateTime(2026, 3, 4, 11, 30, 0)); 
  
  // Check if it took
  delay(1000);
  DateTime now = rtc.now();
  
  Serial.print("New RTC Time: ");
  Serial.print(now.hour());
  Serial.print(":");
  Serial.print(now.minute());
  Serial.print(":");
  Serial.println(now.second());

  if (now.hour() < 24 && now.minute() < 60) {
    Serial.println("SUCCESS! RTC registers are now clean.");
    Serial.println("You can now upload the main SmartMedicineBox.ino code.");
  } else {
    Serial.println("FAILURE: RTC still returning garbage. This is likely a HARDWARE issue (loose GND or low battery).");
  }
}

void loop() {
  // Nothing to do
}
