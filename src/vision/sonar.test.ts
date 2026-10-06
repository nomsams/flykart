import { describe, expect, it } from "vitest";
import { CM_PER_PIXEL, HC_SR04, MOUNT, ROBOT, toPixels } from "./robot";
import { Sonar, SonarTarget, ping, sonarInputs } from "./sonar";
import { mulberry32 } from "./rng";

// No speckle, no false echoes: these tests look at the geometry and the limits, not at luck.
const quiet = { ...HC_SR04, speckleSigma: 0, ghostProbability: 0, noiseBaseCm: 0, noiseProportional: 0, resolutionCm: 0.01 };
const at = { x: 0, y: 0, heading: 0 };
const frontOf = quiet.mountForward;
const wall = (distancePx: number, heading = Math.PI / 2): SonarTarget => ({ kind: "box", x: frontOf + distancePx + 1.5, y: 0, heading, halfLength: 60, halfWidth: 1.5, z0: 0, z1: 60 });
const kart = (distancePx: number): SonarTarget => ({ kind: "box", x: frontOf + distancePx + 12, y: 0, heading: 0, halfLength: 12, halfWidth: 7, z0: 0, z1: 9 });
const pole = (distancePx: number, radius = 1.4): SonarTarget => ({ kind: "circle", x: frontOf + distancePx + radius, y: 0, radius, z0: 0, z1: 17 });
const hear = (targets: SonarTarget[], pose = at) => ping(quiet, pose, targets, mulberry32(1));

it('attenuates soft targets, scatters rough echoes, preserves legacy returns and occlusion',()=>{
 const t=wall(100),original=hear([t]);expect(hear([{...t,surface:'legacy'}])).toEqual(original);
 const hard=hear([{...t,surface:'smooth'}]),soft=hear([{...t,surface:'soft'}]);expect(hard.strength).toBeGreaterThan(soft.strength);expect(soft.echo).toBe(false);
 const angle=wall(80,Math.PI/2+.6);expect(hear([{...angle,surface:'rough'}]).strength).toBeGreaterThan(hear([{...angle,surface:'smooth'}]).strength);
 expect(hear([{...t,surface:'soft'},wall(160)]).echo).toBe(false);expect(hear([wall(160)]).echo).toBe(true);
});

describe("the robot's scale", () => {
  it("matches the simulated kart's size and the sensor mount height", () => {
    expect(24 * CM_PER_PIXEL).toBeGreaterThan(ROBOT.lengthCm * 0.9); expect(24 * CM_PER_PIXEL).toBeLessThan(ROBOT.lengthCm * 1.1);
    expect(14 * CM_PER_PIXEL).toBeGreaterThan(ROBOT.widthCm * 0.85); expect(14 * CM_PER_PIXEL).toBeLessThan(ROBOT.widthCm * 1.05);
    expect(MOUNT.height * CM_PER_PIXEL).toBeCloseTo(6.5, 5);
    expect(toPixels(ROBOT.wheelbaseCm)).toBeCloseTo(10.45, 1);
  });
});

describe("HC-SR04 model", () => {
  it("reads a flat wall squarely ahead accurately from the shortest to the longest range", () => {
    for (const cm of [10, 50, 150, 300, 380]) {
      const reading = hear([wall(cm / CM_PER_PIXEL)]);
      expect(reading.echo, `${cm} cm`).toBe(true);
      expect(reading.range * CM_PER_PIXEL).toBeGreaterThan(cm * 0.96); expect(reading.range * CM_PER_PIXEL).toBeLessThan(cm * 1.06 + 1);
    }
  });
  it("hears nothing beyond its range, or when nothing is there", () => {
    expect(hear([]).echo).toBe(false);
    expect(hear([wall(430 / CM_PER_PIXEL)]).echo).toBe(false);
    expect(hear([]).range * CM_PER_PIXEL).toBeCloseTo(HC_SR04.maxRangeCm, 3);
  });
  it("loses a wall seen at a slant, which bounces the ping away", () => {
    expect(hear([wall(120 / CM_PER_PIXEL, Math.PI / 2)]).echo).toBe(true);
    expect(hear([wall(120 / CM_PER_PIXEL, Math.PI / 2 + 0.35)]).echo).toBe(true);
    expect(hear([wall(120 / CM_PER_PIXEL, Math.PI / 2 + 1.0)]).echo).toBe(false);
  });
  it("sees a pole or a cone only up close, and a kart-sized box a bit farther", () => {
    expect(hear([pole(40 / CM_PER_PIXEL)]).echo).toBe(true);
    expect(hear([pole(200 / CM_PER_PIXEL)]).echo).toBe(false);
    expect(hear([kart(100 / CM_PER_PIXEL)]).echo).toBe(true);
    expect(hear([kart(300 / CM_PER_PIXEL)]).echo).toBe(false);
  });
  it("cannot see things that lie flat on the floor, or hang well above the beam", () => {
    const flat: SonarTarget = { kind: "box", x: frontOf + 60, y: 0, heading: Math.PI / 2, halfLength: 60, halfWidth: 1.5, z0: 0, z1: 0.4 };
    const overhead: SonarTarget = { kind: "box", x: frontOf + 60, y: 0, heading: Math.PI / 2, halfLength: 60, halfWidth: 1.5, z0: 36, z1: 42 };
    expect(hear([flat]).echo).toBe(false);
    expect(hear([overhead]).echo).toBe(false);
    expect(hear([wall(60)]).echo).toBe(true);
  });
  it("has a beam about 15 degrees wide: a target to one side is heard only if it is inside the cone", () => {
    const aside = (degrees: number): SonarTarget => ({ kind: "circle", x: frontOf + 60 * Math.cos((degrees * Math.PI) / 180), y: 60 * Math.sin((degrees * Math.PI) / 180), radius: 6, z0: 0, z1: 20 });
    expect(hear([aside(0)]).echo).toBe(true);
    expect(hear([aside(10)]).echo).toBe(true);
    expect(hear([aside(35)]).echo).toBe(false);
  });
  it("reports the nearest of two things in the cone", () => {
    const reading = hear([wall(200), pole(60, 4)]);
    expect(reading.range).toBeLessThan(80);
  });
  it("gets noisier and quantised under the real error model", () => {
    const readings = Array.from({ length: 200 }, (_, i) => ping(HC_SR04, at, [wall(100)], mulberry32(i + 1)).range * CM_PER_PIXEL).filter((cm) => cm < 150);
    const mean = readings.reduce((s, v) => s + v, 0) / readings.length;
    const spread = Math.sqrt(readings.reduce((s, v) => s + (v - mean) ** 2, 0) / readings.length);
    expect(spread).toBeGreaterThan(0.2); expect(spread).toBeLessThan(2);
  });
  it("pings every other tick and holds the reading between pings", () => {
    const sonar = new Sonar(quiet, mulberry32(3));
    const fresh = [0, 1, 2, 3, 4, 5].map((tick) => sonar.update(tick, at, [wall(80)]));
    expect(fresh).toEqual([true, false, true, false, true, false]);
    expect(sonar.reading.echo).toBe(true);
  });
  it("turns a reading into the controller's two inputs", () => {
    expect(sonarInputs({ range: 100, echo: true, strength: 10 }, 200)[0]).toBeCloseTo(0.5, 5);
    expect(sonarInputs({ range: 364, echo: false, strength: 0 }, 200)).toEqual([0, 0]);
    expect(sonarInputs({ range: 50, echo: true, strength: 1 }, 200)[1]).toBe(0);
  });
});
