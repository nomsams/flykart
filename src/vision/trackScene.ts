// The race track as something a camera can look at: asphalt, kerbs, grass,
// lane lines, checkpoint gantries, other karts, cones, barriers and oil.
import { CAR_LENGTH, CAR_WIDTH, CAR_COLLISION_DIAMETER, Car, TrackDefinition, trackCheckpoint } from "../core";
import { Pose, Rgb, Scene, Sprite, Style, hexToRgb } from "./camera";
import { hash2 } from "./rng";

const KERB_WIDTH = 7;
const OIL_RADIUS = 28;
const GATE_BAND = 3;
const NEAR_SEGMENT_RANGE = 230;

const mix = (a: Rgb, b: Rgb, t: number, out: Rgb): void => { out[0] = a[0] + (b[0] - a[0]) * t; out[1] = a[1] + (b[1] - a[1]) * t; out[2] = a[2] + (b[2] - a[2]) * t; };

export class TrackScene implements Scene {
  sprites: Sprite[] = [];
  private readonly gantries: Sprite[] = [];
  private readonly gateDistances: number[] = [];
  private readonly ax: Float64Array; private readonly ay: Float64Array; private readonly dx: Float64Array; private readonly dy: Float64Array;
  private readonly length2: Float64Array; private readonly cumulative: Float64Array; private readonly segmentLength: Float64Array;
  private near: number[] = [];
  private traffic: Sprite[] = [];
  private oil: { x: number; y: number }[] = [];
  private readonly half: number;

  constructor(readonly route: TrackDefinition, public style: Style, readonly gateCount = 8) {
    const n = route.points.length;
    this.ax = new Float64Array(n); this.ay = new Float64Array(n); this.dx = new Float64Array(n); this.dy = new Float64Array(n);
    this.length2 = new Float64Array(n); this.cumulative = new Float64Array(n); this.segmentLength = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      const a = route.points[i], b = route.points[(i + 1) % n];
      this.ax[i] = a.x; this.ay[i] = a.y; this.dx[i] = b.x - a.x; this.dy[i] = b.y - a.y;
      this.length2[i] = Math.max(1e-6, this.dx[i] ** 2 + this.dy[i] ** 2); this.cumulative[i] = route.cumulativeLengths[i]; this.segmentLength[i] = route.segmentLengths[i];
    }
    this.half = route.width / 2;
    for (let index = 0; index < gateCount; index += 1) {
      const gate = trackCheckpoint(index, route, gateCount);
      this.gateDistances.push(gate.distanceAlong);
      const heading = Math.atan2(gate.tangent.y, gate.tangent.x);
      const span = this.half + 5;
      const post = (side: number): Sprite => ({ x: gate.point.x + gate.normal.x * span * side, y: gate.point.y + gate.normal.y * span * side, heading, width: 3, length: 3, z0: 0, z1: 17, color: index === 0 ? [0.95, 0.95, 0.95] : [0.95, 0.72, 0.1], shape: "post" });
      this.gantries.push(post(-1), post(1), { x: gate.point.x, y: gate.point.y, heading, width: span * 2, length: 2.4, z0: 14, z1: 19, color: index === 0 ? [0.96, 0.96, 0.96] : [1, 0.82, 0.25], shape: "banner" });
    }
  }

  /** Describe the other vehicles the camera may see. Crashed or finished vehicles no longer exist for the physics, so they are not drawn. */
  setTraffic(cars: Car[], self: Car): void {
    this.traffic = []; this.oil = [];
    for (const car of cars) {
      if (car === self || car.crashed || car.finished || car.timedOut || car.eliminated || car.trackId !== self.trackId) continue;
      if (car.isObstacle && car.obstacleKind === "oil") { this.oil.push({ x: car.position.x, y: car.position.y }); continue; }
      const color = hexToRgb(car.color.length === 7 ? car.color : "#f19a69");
      if (car.isObstacle && car.obstacleKind === "barrier") this.traffic.push({ x: car.position.x, y: car.position.y, heading: car.heading, width: CAR_COLLISION_DIAMETER * 1.4, length: 7, z0: 0, z1: 9, color, shape: "wall" });
      else if (car.isObstacle && car.obstacleKind === "cone") this.traffic.push({ x: car.position.x, y: car.position.y, heading: car.heading, width: 9, length: 9, z0: 0, z1: 10, color: [0.97, 0.45, 0.12], shape: "cone" });
      else this.traffic.push({ x: car.position.x, y: car.position.y, heading: car.heading, width: CAR_WIDTH, length: CAR_LENGTH, z0: 0, z1: 9, color, shape: "kart" });
    }
  }

  prepare(pose: Pose): void {
    this.near = [];
    for (let i = 0; i < this.ax.length; i += 1) {
      const t = Math.max(0, Math.min(1, ((pose.x - this.ax[i]) * this.dx[i] + (pose.y - this.ay[i]) * this.dy[i]) / this.length2[i]));
      const px = this.ax[i] + this.dx[i] * t - pose.x, py = this.ay[i] + this.dy[i] * t - pose.y;
      if (px * px + py * py < NEAR_SEGMENT_RANGE * NEAR_SEGMENT_RANGE) this.near.push(i);
    }
    if (this.near.length === 0) for (let i = 0; i < this.ax.length; i += 1) this.near.push(i);
    const range2 = 520 * 520;
    this.sprites = this.gantries.filter((sprite) => (sprite.x - pose.x) ** 2 + (sprite.y - pose.y) ** 2 < range2).concat(this.traffic);
  }

  ground(x: number, y: number, out: Rgb): void {
    const style = this.style;
    let bestD2 = Infinity, best = 0, bestT = 0;
    for (const i of this.near) {
      const t = Math.max(0, Math.min(1, ((x - this.ax[i]) * this.dx[i] + (y - this.ay[i]) * this.dy[i]) / this.length2[i]));
      const px = this.ax[i] + this.dx[i] * t - x, py = this.ay[i] + this.dy[i] * t - y;
      const d2 = px * px + py * py;
      if (d2 < bestD2) { bestD2 = d2; best = i; bestT = t; }
    }
    const d = Math.sqrt(bestD2);
    const cross = this.dx[best] * (y - this.ay[best]) - this.dy[best] * (x - this.ax[best]);
    const side = cross >= 0 ? d : -d;
    const along = this.cumulative[best] + this.segmentLength[best] * bestT;
    const half = this.half;
    if (d <= half) {
      if (d > half - KERB_WIDTH) { const c = Math.floor(along / 9) % 2 === 0 ? style.kerbA : style.kerbB; out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; return; }
      // Gates: the finish line is chequered, the others are a yellow band.
      for (let g = 0; g < this.gateDistances.length; g += 1) {
        let delta = Math.abs(along - this.gateDistances[g]); delta = Math.min(delta, this.route.length - delta);
        if (delta > GATE_BAND) continue;
        if (g === 0) { const c = (Math.floor(side / 7) + Math.floor(along / 3.2)) % 2 === 0 ? 0.96 : 0.06; out[0] = c; out[1] = c; out[2] = c; }
        else { const c = style.gate; out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; }
        return;
      }
      // Painted lines: dashed centre line and solid edge lines.
      if (Math.abs(side) < 1.6 && along % 34 < 15) { const c = style.line; out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; return; }
      if (d > half - KERB_WIDTH - 3 && d < half - KERB_WIDTH - 0.6) { const c = style.line; out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; return; }
      const wear = hash2(Math.floor(x / 14), Math.floor(y / 14)) < 0.38;
      const base = wear ? style.asphaltWorn : style.asphalt;
      out[0] = base[0]; out[1] = base[1]; out[2] = base[2];
      for (const spill of this.oil) {
        const distance = Math.hypot(x - spill.x, y - spill.y);
        if (distance < OIL_RADIUS) { mix(base, style.oil, Math.min(1, (OIL_RADIUS - distance) / 5), out); const sheen = Math.max(0, 1 - Math.abs(distance - OIL_RADIUS * 0.45) / 5) * 0.35; out[0] += sheen * 0.4; out[1] += sheen * 0.3; out[2] += sheen * 0.6; }
      }
      return;
    }
    // Verge: a short run of gravel, then two-tone grass squares.
    if (d < half + 9) { const c = style.sand; out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; return; }
    const checker = (Math.floor(x / 26) + Math.floor(y / 26)) % 2 === 0;
    const grass = checker ? style.grassA : style.grassB;
    const speckle = 0.94 + 0.12 * hash2(Math.floor(x / 5), Math.floor(y / 5));
    out[0] = grass[0] * speckle; out[1] = grass[1] * speckle; out[2] = grass[2] * speckle;
  }
}
