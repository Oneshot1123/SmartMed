/* 
  SmartMed I2C LCD "Hard Test"
  If the scanner sees 0x27 but you see no text, run this.
*/

#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// Try 0x27 as found by scanner
LiquidCrystal_I2C lcd(0x27, 16, 2); 

void setup() {
  Serial.begin(115200);
  
  // Use GPIO 21 and 22 for ESP32
  Wire.begin(21, 22);
  
  Serial.println("Initializing LCD...");
  
  lcd.init();                      // Standard init
  lcd.backlight();                 // Turn on backlight
  
  lcd.setCursor(0, 0);
  lcd.print("I2C TEST: OK!");
  lcd.setCursor(0, 1);
  lcd.print("SmartMed Active");
  
  Serial.println("LCD Initialized. If screen is blank, turn the CONTRAST POT on the back!");
}

void loop() {
  // Blink backlight to prove we have communication
  Serial.println("Blinking backlight...");
  lcd.backlight();
  delay(1000);
  lcd.noBacklight();
  delay(1000);
}
