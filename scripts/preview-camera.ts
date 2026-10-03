// Render a handful of camera views to a PNG so the eyes can be checked by eye.
//   npx vite-node scripts/preview-camera.ts <out.png>
import { TRACKS, createRoadObstacles, pointAtDistance, startPosition } from "../src/core";
import { DEFAULT_CAMERA, DEFAULT_STYLE, frameLength, frameToRgba, randomStyle, renderFrame } from "../src/vision/camera";
import { TrackScene } from "../src/vision/trackScene";
import { profileById } from "../src/vision/robot";
import { mulberry32 } from "../src/vision/rng";
import { montage, writePng } from "./png";

const out = process.argv[2] ?? "camera-preview.png";
const images: { rgba: Uint8ClampedArray; width: number; height: number }[] = [];
const random = mulberry32(5);
const profile = profileById(process.argv[3]);
const config = profile.camera;
const frame = new Float32Array(frameLength(config));
const route = TRACKS.find((track) => track.id === "grand-loop")!;
const views = [
  { track: "grand-loop", at: 40, lane: 0, rivals: false, objects: 0, style: 0 },
  { track: "grand-loop", at: 300, lane: 0.6, rivals: false, objects: 0, style: 0 },
  { track: "hairpin", at: 560, lane: 0, rivals: false, objects: 0, style: 0 },
  { track: "chicane", at: 700, lane: -0.5, rivals: false, objects: 0, style: 0 },
  { track: "grand-loop", at: 120, lane: 0, rivals: true, objects: 3, style: 0 },
  { track: "mountain-pass", at: 500, lane: 0, rivals: true, objects: 4, style: 0 },
  { track: "grand-loop", at: 40, lane: 0, rivals: false, objects: 0, style: 1 },
  { track: "grand-loop", at: 300, lane: 0, rivals: false, objects: 2, style: 1 },
  { track: "sharp-turn", at: 400, lane: 0.2, rivals: true, objects: 2, style: 1 },
];
for (const view of views) {
  const r = TRACKS.find((track) => track.id === view.track) ?? route;
  const car = startPosition(0, r); const sample = pointAtDistance(view.at, r);
  const normal = { x: -sample.tangent.y, y: sample.tangent.x };
  car.position = { x: sample.point.x + normal.x * view.lane * r.width / 2, y: sample.point.y + normal.y * view.lane * r.width / 2 };
  car.heading = Math.atan2(sample.tangent.y, sample.tangent.x);
  const others = [car];
  if (view.rivals) { const rival = startPosition(0, r); const ahead = pointAtDistance(view.at + 90, r); rival.position = { x: ahead.point.x + normal.x * 18, y: ahead.point.y + normal.y * 18 }; rival.heading = Math.atan2(ahead.tangent.y, ahead.tangent.x); others.push(rival); }
  if (view.objects) others.push(...createRoadObstacles(view.objects, r, view.at, "mixed").map((o) => { const near = pointAtDistance(view.at + 70 + Math.floor(Math.random() * 40), r); o.position = { x: near.point.x + normal.x * (Math.random() - 0.5) * 60, y: near.point.y + normal.y * (Math.random() - 0.5) * 60 }; return o; }));
  const scene = new TrackScene(r, view.style ? randomStyle(random, 1) : DEFAULT_STYLE, 8, profile.gantry);
  scene.setTraffic(others, car);
  renderFrame(scene, { x: car.position.x, y: car.position.y, heading: car.heading }, config, frame, random);
  images.push({ rgba: frameToRgba(frame, config), width: config.width, height: config.height });
}
const sheet = montage(images, 3, 8);
writePng(out, sheet.width, sheet.height, sheet.rgba);
console.log("wrote", out, sheet.width, "x", sheet.height);
