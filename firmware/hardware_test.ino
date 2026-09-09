/* 
  SmartMed Hardware Test Utility
  Use this to verify your wiring for LCD, LEDs, and Buzzer.
  NO WiFi or Firebase required.
*/

#include <LiquidCrystal.h>

// Pins from the main project
const int rs = 14, en = 12, d4 = 26, d5 = 25, d6 = 33, d7 = 32;
LiquidCrystal lcd(rs, en, d4, d5, d6, d7);

const int greenLed = 18;
const int yellowLed = 19;
const int redLed = 23;
const int buzzerPin = 13;

void setup() {
  Serial.begin(115200);
  
  pinMode(greenLed, OUTPUT);
  pinMode(yellowLed, OUTPUT);
  pinMode(redLed, OUTPUT);
  pinMode(buzzerPin, OUTPUT);

  // Initialize LCD
  lcd.begin(16, 2);
  lcd.print("Testing LCD...");
  lcd.setCursor(0, 1);
  lcd.print("Hello SmartMed!");
  
  Serial.println("Hardware Test Started.");
}

void loop() {
  // Test LEDs
  Serial.println("Blinking Green...");
  digitalWrite(greenLed, HIGH);
  delay(500);
  digitalWrite(greenLed, LOW);
  
  Serial.println("Blinking Yellow...");
  digitalWrite(yellowLed, HIGH);
  delay(500);
  digitalWrite(yellowLed, LOW);
  
  Serial.println("Blinking Red...");
  digitalWrite(redLed, HIGH);
  delay(500);
  digitalWrite(redLed, LOW);
  
  // Test Buzzer (Short Beep)
  Serial.println("Beeping...");
  digitalWrite(buzzerPin, HIGH);
  delay(100);
  digitalWrite(buzzerPin, LOW);
  
  lcd.clear();
  lcd.print("LCD: WORKING!");
  lcd.setCursor(0, 1);
  lcd.print("LEDs: OK!");
  
  delay(2000);
}
