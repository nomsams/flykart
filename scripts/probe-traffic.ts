// How far away can the camera network see another kart or a cone?
//   npx vite-node scripts/probe-traffic.ts <vision-net.json>
import { readFileSync } from "node:fs";
import { pointAtDistance, resolveTrack } from "../src/core";
import { TrackEpisode } from "../src/vision/episode";
import { ESTIMATE_NAMES } from "../src/vision/interface";
import { Perceiver } from "../src/vision/perception";

const model = JSON.parse(readFileSync(process.argv[2] ?? "public/vision/vision-net.json", "utf8"));
const perceiver = new Perceiver(model);
const idx = (name: string) => ESTIMATE_NAMES.indexOf(name as never);
const track = resolveTrack("grand-loop");
for (const kind of ["cone", "stalled-car", "barrier"] as const) {
  console.log(`\n${kind}: distance ahead -> truth closeness / predicted closeness (± σ), predicted side, predicted obstacle flag`);
  for (const lateral of [-0.35, 0, 0.35]) {
    const row: string[] = [];
    for (const distance of [30, 50, 70, 90, 120, 150, 180, 220]) {
      const episode = new TrackEpisode({ track, seed: 5, headless: false, roadObjects: 1, objectKind: kind });
      const start = pointAtDistance(60, track), ahead = pointAtDistance(60 + distance, track);
      episode.car.position = { ...start.point }; episode.car.heading = Math.atan2(start.tangent.y, start.tangent.x); episode.car.speed = 40;
      const object = episode.roadObjects[0]; const normal = { x: -ahead.tangent.y, y: ahead.tangent.x };
      object.position = { x: ahead.point.x + normal.x * lateral * track.width / 2, y: ahead.point.y + normal.y * lateral * track.width / 2 };
      perceiver.reset();
      const truth = episode.truth();
      let p = perceiver.perception;
      for (let k = 0; k < 3; k += 1) p = perceiver.see(episode.render(), episode.proprioception());
      row.push(`${distance}px: ${truth[idx("trafficClose")].toFixed(2)}/${p.mean[idx("trafficClose")].toFixed(2)}±${Math.sqrt(p.variance[idx("trafficClose")]).toFixed(2)}`);
    }
    console.log(`  lateral ${lateral.toFixed(2)}  ${row.join("  ")}`);
  }
}
