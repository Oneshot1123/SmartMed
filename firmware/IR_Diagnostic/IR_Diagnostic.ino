/* 
  SmartMed IR & LED Diagnostic
  Use this to find out why your sensors or LEDs aren't lighting up.
*/

const int ir1Pin = 32, ir2Pin = 16, ir3Pin = 17;
const int greenLed = 18, yellowLed = 19, redLed = 23;
const int buzzerPin = 13;

void setup() {
  Serial.begin(115200);
  
  // Use PULLUP just in case your sensors are open-collector
  pinMode(ir1Pin, INPUT_PULLUP); 
  pinMode(ir2Pin, INPUT_PULLUP); 
  pinMode(ir3Pin, INPUT_PULLUP);
  
  pinMode(greenLed, OUTPUT);
  pinMode(yellowLed, OUTPUT);
  pinMode(redLed, OUTPUT);
  pinMode(buzzerPin, OUTPUT);

  Serial.println("--- SMARTMED HARDWARE DIAGNOSTIC ---");
  Serial.println("1. Checking LEDs and Buzzer...");
  
  digitalWrite(redLed, HIGH); delay(500); digitalWrite(redLed, LOW);
  digitalWrite(yellowLed, HIGH); delay(500); digitalWrite(yellowLed, LOW);
  digitalWrite(greenLed, HIGH); delay(500); digitalWrite(greenLed, LOW);
  
  digitalWrite(buzzerPin, HIGH); delay(100); digitalWrite(buzzerPin, LOW);
  
  Serial.println("2. Monitoring IR Sensors (Move your hand in front of them)");
}

void loop() {
  int v1 = digitalRead(ir1Pin);
  int v2 = digitalRead(ir2Pin);
  int v3 = digitalRead(ir3Pin);

  Serial.print("IR1: "); Serial.print(v1);
  Serial.print(" | IR2: "); Serial.print(v2);
  Serial.print(" | IR3: "); Serial.println(v3);

  // If ANY sensor triggers (changes from its base state), blink its corresponding LED
  // Most sensors are HIGH normally and LOW when triggered (if using PULLUP)
  // Or LOW normally and HIGH when triggered.
  
  if (v1 == LOW) digitalWrite(redLed, HIGH); else digitalWrite(redLed, LOW);
  if (v2 == LOW) digitalWrite(yellowLed, HIGH); else digitalWrite(yellowLed, LOW);
  if (v3 == LOW) digitalWrite(greenLed, HIGH); else digitalWrite(greenLed, LOW);

  delay(200);
}
