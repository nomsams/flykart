import { Action, clamp, wrapAngle } from "../core";
import { Pose, Wiring } from "./model";
import { defaultSketch } from "./firmware";

export type ProgramId = "sequence" | "scan" | "avoid" | "fly" | "manual" | "custom";
export const PROGRAMS: { id: ProgramId; title: string; file: string; description: string; mode: string }[] = [
  { id: "sequence", title: "01 · Straight & turn check", file: "drivetrain-check.ino", description: "A repeatable forward → left → straight → forward → left sequence, then the same with right turns. No neural control. Each phase reports its measured motion.", mode: "sketch" },
  { id: "scan", title: "02 · Drive & scan", file: "drive-and-scan.ino", description: "A simple timed survey: drive, stop, look left, return, look right. Prints ultrasonic distance and camera frame statistics. Edit the timings and PWM in the sketch.", mode: "sketch" },
  { id: "avoid", title: "03 · Sonar avoidance", file: "sonar-avoidance.ino", description: "A hand-written robot: forward on a clear echo, reverse and turn near an obstacle, scan cautiously when distance is unknown.", mode: "sketch" },
  { id: "fly", title: "04 · Fly brain", file: "fly-controller.ino", description: "Camera → visual estimates + sonar → spiking controller → motor adapter → your sketch → GPIO → four wheels. No hidden navigation driver.", mode: "fly" },
  { id: "manual", title: "05 · Manual drive", file: "manual-bridge.ino", description: "WASD or arrow keys provide the motor requests. The editable sketch still controls the actual driver pins.", mode: "manual" },
  { id: "custom", title: "06 · My sketch", file: "robot-controller.ino", description: "Keep and edit your own code. Choose fly, manual or independent sketch requests in the controller panel.", mode: "sketch" },
];
export const CHECK_PHASES = [
  { title: "Drive straight", ms: 2200, left: 120, right: 120, kind: "straight" },
  { title: "Turn left", ms: 1350, left: -85, right: 85, kind: "left" },
  { title: "Wheels straight · settle", ms: 450, left: 0, right: 0, kind: "settle" },
  { title: "Drive straight", ms: 2200, left: 120, right: 120, kind: "straight" },
  { title: "Turn left again", ms: 1350, left: -85, right: 85, kind: "left" },
  { title: "Wheels straight · settle", ms: 450, left: 0, right: 0, kind: "settle" },
  { title: "Drive straight", ms: 2200, left: 120, right: 120, kind: "straight" },
  { title: "Turn right", ms: 1350, left: 85, right: -85, kind: "right" },
  { title: "Wheels straight · settle", ms: 450, left: 0, right: 0, kind: "settle" },
  { title: "Drive straight", ms: 2200, left: 120, right: 120, kind: "straight" },
  { title: "Turn right again", ms: 1350, left: 85, right: -85, kind: "right" },
  { title: "Wheels straight · settle", ms: 450, left: 0, right: 0, kind: "settle" },
  { title: "Cycle complete · stop", ms: 1200, left: 0, right: 0, kind: "settle" },
] as const;
export const CHECK_PERIOD = CHECK_PHASES.reduce((n, p) => n + p.ms, 0);

/** Independent, named motor adapters; these are NOT anatomical leg neurons. */
export type MotorAdapter = { steering: "arc" | "pivot"; turnGain: number; maxPWM: number; leftSource: "L1" | "L2" | "L3" | "R1" | "R2" | "R3"; rightSource: MotorAdapter["leftSource"]; invertLeft: boolean; invertRight: boolean };
export const DEFAULT_ADAPTER: MotorAdapter = { steering: "arc", turnGain: .55, maxPWM: 200, leftSource: "L1", rightSource: "R1", invertLeft: false, invertRight: false };
export function validateAdapter(raw: unknown): MotorAdapter {
  const r = raw as MotorAdapter;
  if (!r || !["arc", "pivot"].includes(r.steering) || !Number.isFinite(r.turnGain) || r.turnGain < 0 || r.turnGain > 1 || !Number.isFinite(r.maxPWM) || r.maxPWM < 0 || r.maxPWM > 255 || !["L1", "L2", "L3", "R1", "R2", "R3"].includes(r.leftSource) || !["L1", "L2", "L3", "R1", "R2", "R3"].includes(r.rightSource) || typeof r.invertLeft !== "boolean" || typeof r.invertRight !== "boolean") throw new Error("Invalid motor adapter.");
  return { steering: r.steering, turnGain: r.turnGain, maxPWM: r.maxPWM, leftSource: r.leftSource, rightSource: r.rightSource, invertLeft: r.invertLeft, invertRight: r.invertRight };
}
export function motorRequests(action: Action, adapter: MotorAdapter): { left: number; right: number; legs: Record<MotorAdapter["leftSource"], number> } {
  const drive = clamp(action.throttle - (action.reverse ?? 0), -1, 1) * (1 - clamp(action.brake, 0, 1));
  // Arc mode preserves the brain's forward/reverse decision. Neutral drive
  // cannot be turned into an unintended spin by steering alone.
  const turn = action.steer * adapter.turnGain * (adapter.steering === "arc" ? Math.abs(drive) : 1);
  const left = clamp(drive + turn, -1, 1) * adapter.maxPWM, right = clamp(drive - turn, -1, 1) * adapter.maxPWM;
  const legs = { L1: left, L2: left, L3: left, R1: right, R2: right, R3: right };
  return { left: legs[adapter.leftSource] * (adapter.invertLeft ? -1 : 1), right: legs[adapter.rightSource] * (adapter.invertRight ? -1 : 1), legs };
}

const SCAN_LOOP = `  const int DRIVE_MS = 1800;
  const int LOOK_MS = 900;
  float t = (millis() - started) % 7000;
  float left = 0; float right = 0;
  if (t < DRIVE_MS) { phase(0); left = 100; right = 100; }
  else if (t < 2400) { phase(1); }
  else if (t < 2400 + LOOK_MS) { phase(2); left = -65; right = 65; }
  else if (t < 4200) { phase(3); left = 65; right = -65; }
  else if (t < 5100) { phase(4); left = 65; right = -65; }
  else if (t < 6000) { phase(5); left = -65; right = 65; }
  else { phase(6); }
  motor(IN1, IN2, left); motor(IN3, IN4, right);
  report(readSonarCm());
  delay(67);`;
export function programSketch(id: ProgramId, wiring: Wiring): string {
  if (id === "custom") return defaultSketch(wiring);
  let source = defaultSketch(wiring);
  source = source.replace(/^\/\/ brainLeft[^\n]*\n\/\/ These two functions[^\n]*\n/m, "").replace(/^const float STOP_CM[^\n]*\n/m, "");
  source = source.replace("void setup() {", "long started = 0;\n\nvoid setup() {\n  Serial.begin(115200);\n  started = millis();");
  const report = `void report(float cm) {
  Serial.print("sonar_cm="); Serial.print(cm);
  Serial.print(" camera_frame="); Serial.print(cameraFrame());
  Serial.print(" mean_rgb="); Serial.print(cameraMeanR());
  Serial.print(","); Serial.print(cameraMeanG());
  Serial.print(","); Serial.println(cameraMeanB());
}

`;
  source = source.slice(0, source.indexOf("void loop()")) + report;
  let loop = "";
  if (id === "sequence") {
    let cumulative = 0;
    loop = `  // Edit PWM values and phase boundaries to calibrate the chassis.\n  // Negative left / positive right = left pivot; equal PWM = straight.\n  float t = (millis() - started) % ${CHECK_PERIOD};\n  float left = 0; float right = 0;\n`;
    CHECK_PHASES.forEach((p, i) => { cumulative += p.ms; loop += `  ${i ? "else " : ""}if (t < ${cumulative}) { phase(${i}); left = ${p.left}; right = ${p.right}; } // ${p.title}\n`; });
    loop += "  motor(IN1, IN2, left); motor(IN3, IN4, right);\n  report(readSonarCm());\n  delay(67);";
  } else if (id === "scan") loop = SCAN_LOOP;
  else if (id === "avoid") loop = `  const float NEAR_CM = 25;
  float cm = readSonarCm();
  float left = 105; float right = 105;
  if (cm < 0) { phase(0); left = -55; right = 55; } // unknown: scan
  else if (cm < NEAR_CM) { phase(1); left = -90; right = -40; }
  else { phase(2); }
  motor(IN1, IN2, left); motor(IN3, IN4, right);
  report(cm); delay(67);`;
  else loop = `  // The adapter wiring panel controls brainLeft()/brainRight().
  float cm = readSonarCm();
  float left = brainLeft();
  float right = brainRight();
  motor(IN1, IN2, left); motor(IN3, IN4, right);
  report(cm); delay(67);`;
  return source.replace("// Arduino-style simulation sketch. ESP32-CAM + L298N.", `// ${PROGRAMS.find(p => p.id === id)!.title}\n// Editable Arduino-style controller. All motor writes execute in simulation.`) + `void loop() {\n${loop}\n}\n`;
}

export type CheckResult = { phase: number; title: string; distanceCm: number; yawDeg: number; contacts: number; passed: boolean; reason: string };
export class DrivetrainCheck {
  phase = -1; cycles = 0;
  readonly results: CheckResult[] = [];
  private start: Pose | null = null;
  private contacts = 0;
  observe(index: number, pose: Pose, collisions: number): CheckResult | null {
    if (!Number.isInteger(index) || !CHECK_PHASES[index] || index === this.phase) return null;
    let result: CheckResult | null = null;
    if (this.phase >= 0 && this.start) {
      const p = CHECK_PHASES[this.phase], distanceCm = Math.hypot(pose.x - this.start.x, pose.z - this.start.z) * 100, yawDeg = wrapAngle(pose.heading - this.start.heading) * 180 / Math.PI, contacts = collisions - this.contacts;
      const passed = contacts === 0 && (p.kind === "straight" ? distanceCm > 20 && Math.abs(yawDeg) < 5 : p.kind === "left" ? yawDeg < -35 : p.kind === "right" ? yawDeg > 35 : true);
      result = { phase: this.phase, title: p.title, distanceCm, yawDeg, contacts, passed, reason: contacts ? "Obstacle contact" : p.kind === "straight" ? "Distance >20 cm; heading drift <5°" : p.kind === "settle" ? "Settling phase" : "Turn has the expected direction (>35°)" };
      this.results.push(result); if (this.results.length > 52) this.results.shift();
    }
    if (index < this.phase) this.cycles++;
    this.phase = index; this.start = { ...pose }; this.contacts = collisions;
    return result;
  }
}
