import { describe, expect, it } from "vitest";
import { DEFAULT_ROBOT, ESP_WIRING, RobotPhysics, RobotSonar, ROOM_TYPES, makeObject, preset, traversable, robotContactParts, overlaps, solidsFor, wiringIssues } from "./model";
import { polygonsOverlap, rectangle } from "./contacts";
import { Firmware, defaultSketch } from "./firmware";
import { RoomMemory } from "./memory";
import { CHECK_PERIOD, DEFAULT_ADAPTER, DrivetrainCheck, motorRequests, PROGRAMS, programSketch } from "./controls";
import { DEFAULT_NOISE, NoiseSource, validateNoise } from "./noise";
import { highlightedCode } from "./editor";
import { SensorConsole } from "./telemetry";
import { CAMERA_PINS, wiringConnections } from "./wiring-diagram";

const host = (timeMs: number, left = 128, right = 128, echoUs = 5800) => ({ timeMs, brainLeft: left, brainRight: right, echoUs, wiring: ESP_WIRING });
const runSketch = (f: Firmware, left = 128, right = 128, echo = 5800, end = 1000) => { for (let time = 0; time <= end; time += 1000 / 30) f.tick(host(time, left, right, echo)); };

describe("habitat geometry and drive-over surfaces", () => {
  it("clears the empty corners of a bush bounding box and still blocks foliage", () => {
    const bush = makeObject("bush"), physics = new RobotPhysics(); physics.pose = { x: .3, z: .27, heading: 0 };
    const body = { x: .3, z: .27, yaw: 0, width: DEFAULT_ROBOT.length, depth: DEFAULT_ROBOT.width, bottom: 0, top: .105 };
    expect(overlaps(body, solidsFor(bush)[0])).toBe(true);
    expect(robotContactParts(bush, DEFAULT_ROBOT).some(p => polygonsOverlap(rectangle(body), p.polygon))).toBe(false);
    physics.step(.5, .5, [bush], .1); expect(physics.blocked).toBe(false); expect(physics.pose.x).toBeGreaterThan(.3);
    physics.pose = { x: -.28, z: 0, heading: 0 }; physics.step(.5, .5, [bush], .1); expect(physics.contact?.part).toBe("bush foliage");
  });
  it("passes beneath table, chair and bed while colliding with their legs and low undersides", () => {
    for (const kind of ["table", "chair", "bed"] as const) {
      const o = makeObject(kind), physics = new RobotPhysics(); physics.pose = { x: 0, z: 0, heading: 0 };
      physics.step(.5, .5, [o], .1); expect(physics.blocked, kind).toBe(false);
      const leg = solidsFor(o)[1]; physics.pose = { x: leg.x, z: leg.z, heading: 0 }; physics.step(.5, .5, [o], .1); expect(physics.contact?.part).toMatch(/leg/);
      o.height = .12; physics.pose = { x: 0, z: 0, heading: 0 }; physics.step(.5, .5, [o], .1); expect(physics.blocked, kind).toBe(true);
    }
  });
  it("invalidates shape caches after inspector edits and handles rotated natural objects", () => {
    const rock = makeObject("rock"); rock.yaw = .65;
    const first = robotContactParts(rock, DEFAULT_ROBOT); rock.width *= 2;
    const second = robotContactParts(rock, DEFAULT_ROBOT); expect(second).not.toBe(first);
    const body = rectangle({ x: 0, z: 0, yaw: 1, width: .26, depth: .17 }); expect(second.some(p => polygonsOverlap(body, p.polygon))).toBe(true);
    expect(robotContactParts(makeObject("water"), DEFAULT_ROBOT)).toEqual([]);
  });
  it("allows low cables/mats with a traction penalty but blocks oversized versions", () => {
    for (const kind of ["cable", "doormat"] as const) {
      const o = makeObject(kind), physics = new RobotPhysics(), clear = new RobotPhysics(); physics.pose = clear.pose = { x: 0, z: 0, heading: 0 };
      expect(traversable(o, DEFAULT_ROBOT)).toBe(true); physics.step(.5, .5, [o], .1); clear.step(.5, .5, [], .1);
      expect(physics.blocked).toBe(false); expect(physics.collisions).toBe(0); expect(physics.surface?.kind).toBe(kind); expect(physics.speed).toBeLessThan(clear.speed);
      o.height = .03; expect(traversable(o, DEFAULT_ROBOT)).toBe(false); physics.pose = { x: 0, z: 0, heading: 0 }; physics.step(.5, .5, [o], .1); expect(physics.blocked).toBe(true);
    }
  });
  it("starts every furnished preset clear of blocking objects", () => {
    for (const room of ROOM_TYPES) { const physics = new RobotPhysics(), objects = preset(room.id); physics.step(.4, .4, objects, .05); expect(physics.blocked, room.id).toBe(false); expect(objects.length).toBeLessThan(200); }
  });
});

describe("controller workbench", () => {
  it("executes every preset and prints actual sonar and camera readings", () => {
    for (const p of PROGRAMS.filter(p => p.id !== "custom")) {
      const fw = new Firmware(programSketch(p.id, ESP_WIRING)), lines: string[] = [];
      for (let t = 0; t < 1000; t += 1000 / 30) fw.tick({ ...host(t), camera: { frame: 12, rgb: [10, 20, 30] }, log: line => lines.push(line) });
      expect(lines.some(s => s.includes("sonar_cm=100") && s.includes("camera_frame=12") && s.includes("mean_rgb=10,20,30"))).toBe(true);
      expect(fw.currentLine).toBeGreaterThan(10);
    }
  });
  it("measures straight runs and both turn directions through repeated cycles beyond 27 seconds", () => {
    const fw = new Firmware(programSketch("sequence", ESP_WIRING)), physics = new RobotPhysics(), observer = new DrivetrainCheck();
    for (let t = 0; t < CHECK_PERIOD * 2 + 2400; t += 1000 / 30) {
      fw.tick({ ...host(t, 0, 0, 0), phase: index => observer.observe(index, physics.pose, physics.collisions) });
      physics.step(...fw.motors(ESP_WIRING), [], 1 / 30);
    }
    expect(observer.cycles).toBe(2);
    expect(observer.results.filter(p => !p.passed)).toEqual([]);
    expect(observer.results.filter(p => p.title.includes("left")).every(p => p.yawDeg < -35)).toBe(true);
    expect(observer.results.filter(p => p.title.includes("right")).every(p => p.yawDeg > 35)).toBe(true);
    expect(physics.collisions).toBe(0);
  });
  it("applies edited timed-program motor writes", () => {
    const fw = new Firmware(programSketch("sequence", ESP_WIRING).replace("left = 120; right = 120;", "left = 160; right = 90;"));
    runSketch(fw, 0, 0, 0, 700); expect(fw.motors(ESP_WIRING)[0]).toBeCloseTo(160 / 255); expect(fw.motors(ESP_WIRING)[1]).toBeCloseTo(90 / 255);
  });
  it("arc steering cannot turn a zero drive request into rotation, while pivot and routing are explicit", () => {
    const stopped = { throttle: 0, brake: 0, steer: 1 };
    expect(motorRequests(stopped, DEFAULT_ADAPTER).left).toBe(0);
    const pivot = motorRequests(stopped, { ...DEFAULT_ADAPTER, steering: "pivot" }); expect(pivot.left).toBeGreaterThan(0); expect(pivot.right).toBeLessThan(0);
    const cross = motorRequests(stopped, { ...DEFAULT_ADAPTER, steering: "pivot", leftSource: "R2", rightSource: "L3", invertRight: true }); expect(cross.left).toBe(pivot.right); expect(cross.right).toBe(-pivot.left);
    expect(motorRequests({ throttle: 1, brake: 1, steer: 1 }, DEFAULT_ADAPTER).left).toBe(0);
  });
  it("preserves strings containing comments and rejects unsafe editor markup", () => {
    const fw = new Firmware('void setup() {}\nvoid loop() { Serial.println("http://room/<sensor>"); delay(100); }'), lines: string[] = [];
    fw.tick({ ...host(0), log: line => lines.push(line) }); fw.tick({ ...host(33), log: line => lines.push(line) }); expect(lines).toEqual(["http://room/<sensor>"]);
    expect(highlightedCode('// <img src=x onerror=alert()>')).toContain("&lt;img"); expect(highlightedCode("// <img>")).not.toContain("<img>");
  });
  it("camera and sonar noise are seeded, bounded and applied to actual delivered data", () => {
    const config = { ...DEFAULT_NOISE, cameraSigma: 20, sonarSigmaCm: 5 }, a = new NoiseSource(config), b = new NoiseSource(config);
    const pixels = new Uint8ClampedArray([128, 128, 128, 255, 40, 50, 60, 255]), other = pixels.slice();
    a.camera(pixels); b.camera(other); expect(pixels).toEqual(other); expect(pixels[0]).not.toBe(128); expect(a.sonar(1, true)).toEqual(b.sonar(1, true));
    const dropout = new NoiseSource({ ...DEFAULT_NOISE, cameraDropout: 1, sonarDropout: 1 }); dropout.camera(pixels); expect([...pixels]).toEqual([0, 0, 0, 255, 0, 0, 0, 255]); expect(dropout.sonar(1, true)).toEqual({ metres: 4, echo: false });
    expect(() => validateNoise({ ...DEFAULT_NOISE, seed: NaN })).toThrow();
  });
  it("keeps the console bounded and retains structured diagnostics", () => {
    const log = new SensorConsole(2); log.push(0, "system", "start"); log.push(1, "sonar", "echo", { cm: 52 }); log.push(2, "camera", "frame");
    expect(log.events).toHaveLength(2); expect(log.select("sonar")[0].data).toEqual({ cm: 52 }); log.clear(); expect(log.events).toHaveLength(0);
  });
});

describe("component wiring diagram", () => {
  it("uses configured GPIOs and distinguishes enable jumpers from wires", () => {
    const nets = wiringConnections(ESP_WIRING, DEFAULT_ROBOT);
    expect(nets.find(n => n.id === "in1")!.from).toContain("GPIO 12");
    expect(nets.find(n => n.id === "ena")!.pin).toBeUndefined();
    expect(nets.find(n => n.id === "ena")!.from).toContain("jumper");
    const edited = wiringConnections({ ...ESP_WIRING, in1: 1, ena: 3 }, DEFAULT_ROBOT);
    expect(edited.find(n => n.id === "in1")!.from).toContain("GPIO 1"); expect(edited.find(n => n.id === "ena")!.pin).toBe(3);
  });
  it("marks camera GPIO conflicts, duplicate pins and unshifted echo", () => {
    const nets = wiringConnections({ ...ESP_WIRING, in1: 0, in2: 14, echoDivider: false }, DEFAULT_ROBOT);
    for (const id of ["in1", "in2", "in3", "echo"]) expect(nets.find(n => n.id === id)!.state).toBe("error");
    expect(wiringConnections({ ...ESP_WIRING, commonGround: false }, DEFAULT_ROBOT).find(n => n.id === "ground")!.state).toBe("error");
  });
  it("maps internal camera signals and sensor disconnections without inventing UNO camera wiring", () => {
    expect(CAMERA_PINS.find(([signal]) => signal === "XCLK")![1]).toBe(0);
    expect(CAMERA_PINS.find(([signal]) => signal === "Y9 / D7")![1]).toBe(35);
    const off = wiringConnections(ESP_WIRING, { ...DEFAULT_ROBOT, cameraEnabled: false, sonarEnabled: false });
    for (const id of ["trig", "echo", "camera"]) expect(off.find(n => n.id === id)!.state).toBe("off");
    const uno = wiringConnections({ ...ESP_WIRING, board: "uno", echoDivider: false }, DEFAULT_ROBOT);
    expect(uno.find(n => n.id === "camera")!.to).toContain("unspecified"); expect(uno.find(n => n.id === "echo")!.state).toBe("ok");
    expect(off.find(n => n.id === "left")!.to).toContain("Front-left + rear-left");
  });
});

describe("physical robot geometry", () => {
  it("has four-wheel dimensions and a speed derived from tyre circumference", () => {
    const physics = new RobotPhysics({ ...DEFAULT_ROBOT, rpm: 100, bridgeDrop: 0 });
    expect(physics.maxSpeed).toBeCloseTo(.34034, 4); expect(physics.config.wheelbase).toBe(.115);
    physics.config.rpm = 240; expect(physics.maxSpeed).toBeCloseTo(.81681, 4);
  });
  it("can drive under the table top but not through a leg or low chair seat", () => {
    const table = makeObject("table", 0, 0), solids = solidsFor(table);
    const physics = new RobotPhysics(); physics.pose = { x: -.7, z: 0, heading: 0 };
    for (let i = 0; i < 100; i++) physics.step(1, 1, [table], 1 / 30);
    expect(physics.pose.x).toBeGreaterThan(.3); expect(physics.collisions).toBe(0);
    const leg = solids[1]; const body = { ...leg, width: .26, depth: .17, bottom: 0, top: .105 };
    expect(overlaps(body, leg)).toBe(true);
    const chair = { ...makeObject("chair"), height: .15 };
    const low = new RobotPhysics(); low.pose = { x: -.6, z: 0, heading: 0 };
    for (let i = 0; i < 100; i++) low.step(1, 1, [chair], 1 / 30);
    expect(low.collisions).toBeGreaterThan(0); expect(low.pose.x).toBeLessThan(0);
  });
  it("blocks walls while command odometry continues to drift", () => {
    const physics = new RobotPhysics(); physics.pose = { x: -.5, z: 0, heading: 0 }; physics.odometry = { ...physics.pose };
    const wall = { ...makeObject("wall", 0, 0), yaw: Math.PI / 2 };
    for (let i = 0; i < 200; i++) physics.step(1, 1, [wall], 1 / 30);
    expect(physics.pose.x).toBeLessThan(-.15); expect(physics.odometry.x).toBeGreaterThan(1); expect(physics.blocked).toBe(true);
  });
  it("turns by changing the two side speeds", () => {
    const physics = new RobotPhysics(); physics.pose = { x: 0, z: 0, heading: 0 };
    for (let i = 0; i < 30; i++) physics.step(.5, -.5, [], 1 / 30);
    expect(physics.pose.heading).toBeGreaterThan(1); expect(physics.pose.x).toBeCloseTo(0);
  });
});

describe("HC-SR04 in a metre-scale world", () => {
  it("sees a front-facing wall and holds its sample for at least 60 ms", () => {
    const sonar = new RobotSonar(), wall = { ...makeObject("wall", 1, 0), yaw: Math.PI / 2 };
    expect(sonar.update(0, { x: 0, z: 0, heading: 0 }, [wall], DEFAULT_ROBOT)).toBe(true);
    expect(sonar.reading.echo).toBe(true); expect(sonar.metres).toBeCloseTo(.83, 1);
    const reading = { ...sonar.reading }; expect(sonar.update(.033, { x: .4, z: 0, heading: 0 }, [], DEFAULT_ROBOT)).toBe(false); expect(sonar.reading).toEqual(reading);
    expect(sonar.pulseMicroseconds).toBeGreaterThan(4000);
  });
  it("does not invent an echo from a ground-level puddle or disconnected sensor", () => {
    const sonar = new RobotSonar(); sonar.update(0, { x: 0, z: 0, heading: 0 }, [makeObject("water", .5, 0)], DEFAULT_ROBOT);
    expect(sonar.reading.echo).toBe(false); expect(sonar.pulseMicroseconds).toBe(0);
    sonar.update(1, { x: 0, z: 0, heading: 0 }, [makeObject("wall", .5, 0)], { ...DEFAULT_ROBOT, sonarEnabled: false }); expect(sonar.closeness).toBe(0);
  });
  it("hears a wall beneath an elevated table without letting the top occlude it", () => {
    const sonar = new RobotSonar();
    const table = { ...makeObject("table", .6, 0), width: .6, depth: 1.2 };
    const wall = { ...makeObject("wall", 1.2, 0), yaw: Math.PI / 2 };
    sonar.update(0, { x: 0, z: 0, heading: 0 }, [table, wall], DEFAULT_ROBOT);
    expect(sonar.reading.echo).toBe(true); expect(sonar.metres).toBeCloseTo(1.03, 1);
  });
});

describe("component wiring", () => {
  it("accepts the direct profile but reports shared flash and boot constraints", () => { const report = wiringIssues(ESP_WIRING); expect(report.errors).toEqual([]); expect(report.notes.join(" ")).toContain("flash"); expect(report.notes.join(" ")).toContain("boot"); });
  it("rejects camera pins, duplicate pins, SD conflicts and 5 V ECHO", () => {
    expect(wiringIssues({ ...ESP_WIRING, in1: 0 }).errors.join(" ")).toContain("camera");
    expect(wiringIssues({ ...ESP_WIRING, in2: 12 }).errors.join(" ")).toContain("share");
    expect(wiringIssues({ ...ESP_WIRING, sdCard: true }).errors.join(" ")).toContain("SD");
    expect(wiringIssues({ ...ESP_WIRING, echoDivider: false }).errors.join(" ")).toContain("5 V");
  });
});

describe("bounded Arduino-style firmware", () => {
  it("actually maps brain requests through writes to the driver pins", () => {
    const firmware = new Firmware(defaultSketch(ESP_WIRING)); runSketch(firmware, 170, -80);
    const motors = firmware.motors(ESP_WIRING); expect(motors[0]).toBeCloseTo(170 / 255); expect(motors[1]).toBeCloseTo(-80 / 255);
  });
  it("editing the sketch changes movement independently of neural requests", () => {
    const source = defaultSketch(ESP_WIRING).replace("float left = brainLeft();", "float left = 50;").replace("float right = brainRight();", "float right = -50;");
    const firmware = new Firmware(source); runSketch(firmware, 0, 0); expect(firmware.motors(ESP_WIRING)).toEqual([50 / 255, -50 / 255]);
  });
  it("resumes after delays instead of restarting loop and keeps PWM until resumed", () => {
    const firmware = new Firmware("void setup() { pinMode(12, OUTPUT); } void loop() { analogWrite(12, 180); delay(500); analogWrite(12, 0); delay(500); }");
    firmware.tick(host(0)); firmware.tick(host(1)); expect(firmware.pins.get(12)).toBe(180);
    firmware.tick(host(400)); expect(firmware.pins.get(12)).toBe(180);
    firmware.tick(host(502)); expect(firmware.pins.get(12)).toBe(0);
  });
  it("treats sonar timeout as unknown and only adds a reflex when chosen", () => {
    const firmware = new Firmware(defaultSketch(ESP_WIRING, true)); runSketch(firmware, 160, 160, 0); expect(firmware.motors(ESP_WIRING)[0]).toBeCloseTo(160 / 255);
    const close = new Firmware(defaultSketch(ESP_WIRING, true)); runSketch(close, 160, 160, 580); expect(close.motors(ESP_WIRING)).toEqual([-100 / 255, 110 / 255]);
  });
  it("requires a real virtual TRIG pulse before pulseIn can return an echo", () => {
    const source = defaultSketch(ESP_WIRING, true).replace("delayMicroseconds(10)", "delayMicroseconds(2)");
    const firmware = new Firmware(source); runSketch(firmware, 160, 160, 580); expect(firmware.motors(ESP_WIRING)[0]).toBeCloseTo(160 / 255);
  });
  it("rejects unsupported syntax and bounds recursion without evaluating JavaScript", () => {
    expect(() => new Firmware("void setup() {} void loop() { while (true) {} }")).toThrow(/unsupported/);
    expect(() => new Firmware("void setup() {} void loop() { window.location = 0; }")).toThrow(/unsupported character/);
    const f = new Firmware("void recurse() { recurse(); } void setup() { recurse(); } void loop() {}"); expect(() => f.tick(host(0))).toThrow(/execution limit/);
  });
  it("rejects output writes to input pins and constant assignment", () => {
    const f = new Firmware("void setup() { digitalWrite(12, HIGH); } void loop() {}"); expect(() => f.tick(host(0))).toThrow(/pinMode/);
    const c = new Firmware("const int pin = 12; void setup() { pin = 13; } void loop() {}"); expect(() => c.tick(host(0))).toThrow(/constant/);
  });
});

describe("sparse visual Kenyon room memory", () => {
  it("recalls previous observations, exports them and never teaches when disabled", () => {
    const memory = new RoomMemory(), features = new Float32Array(24).fill(.3), estimates = new Float32Array(10).fill(.7);
    expect(memory.observe(features, estimates)).toBeNull(); expect(memory.active).toHaveLength(16);
    memory.observe(features, estimates); memory.observe(features, estimates); const recall = memory.observe(features, estimates, false);
    expect(recall?.[0]).toBeCloseTo(.7); expect(memory.taught).toBe(16);
    const before = memory.toJSON(); memory.observe(features, estimates, false); expect(memory.toJSON()).toEqual(before);
    const loaded = RoomMemory.fromJSON(JSON.parse(JSON.stringify(before))); expect(loaded.observe(features, estimates, false)?.[0]).toBeCloseTo(.7);
  });
  it("marks sonar rays from odometry and validates saved snapshots", () => {
    const memory = new RoomMemory(); memory.mapPing({ x: 0, z: 0, heading: 0 }, .125, 1, true); expect([...memory.map.values()].some(v => v > 0)).toBe(true); expect([...memory.map.values()].some(v => v < 0)).toBe(true);
    const copy = RoomMemory.fromJSON(memory.toJSON()); expect(copy.map).toEqual(memory.map);
    expect(() => RoomMemory.fromJSON({ ...memory.toJSON(), counts: [1] })).toThrow(/Invalid room memory/);
  });
});
