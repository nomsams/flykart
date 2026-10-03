import { describe, expect, it } from "vitest";
import { TRACKS, pointAtDistance } from "../core";
import { ESTIMATE_NAMES, MIRROR_SIGN } from "./interface";
import { TrackEpisode } from "./episode";
import { buildTrack, registerTrack } from "./proceduralTracks";
import { WorldEpisode, worldDomain } from "./world/worldDomain";
import { trackDomain } from "./domains";

// Mirror augmentation flips a picture left-right and flips the labels to match. That is only right if the labels
// really do flip the way MIRROR_SIGN says, so check it against a genuinely mirrored world.
describe("left-right symmetry of the labels", () => {
  const original = TRACKS.find((t) => t.id === "chicane")!;
  const mirrored = registerTrack(buildTrack("chicane-mirrored", "Chicane (mirrored)", original.points.map((p) => ({ x: p.x, y: -p.y })), original.width));

  it("flips the road estimates with the signs used for augmentation", () => {
    for (const [distance, lateral, headingOffset, speed] of [[200, 0.3, 0.12, 40], [650, -0.4, -0.2, 60], [1100, 0.1, 0.3, 25]] as const) {
      const a = new TrackEpisode({ track: original, headless: true, seed: 1 });
      const b = new TrackEpisode({ track: mirrored, headless: true, seed: 1 });
      a.placeAt({ distance, lateral, headingOffset, speed });
      // Put the second kart exactly where the first would be in the mirrored world.
      b.car.position = { x: a.car.position.x, y: -a.car.position.y }; b.car.heading = -a.car.heading; b.car.speed = a.car.speed;
      b.car.progress = a.car.progress; b.car.distanceAlong = a.car.distanceAlong; b.car.totalProgress = a.car.totalProgress; b.car.nextCheckpoint = a.car.nextCheckpoint;
      const ta = a.truth(), tb = b.truth();
      ESTIMATE_NAMES.forEach((name, c) => { if (c < 8) expect(tb[c], `${name} at ${distance}`).toBeCloseTo(ta[c] * MIRROR_SIGN[c], 5); });
    }
  });

  it("flips traffic the same way", () => {
    const a = new TrackEpisode({ track: original, headless: true, seed: 1, roadObjects: 1, objectKind: "cone" });
    const b = new TrackEpisode({ track: mirrored, headless: true, seed: 1, roadObjects: 1, objectKind: "cone" });
    a.placeAt({ distance: 300, lateral: 0, headingOffset: 0, speed: 30 });
    const ahead = pointAtDistance(300 + 80, original);
    a.roadObjects[0].position = { x: ahead.point.x + 12, y: ahead.point.y + 9 };
    b.car.position = { x: a.car.position.x, y: -a.car.position.y }; b.car.heading = -a.car.heading; b.car.speed = a.car.speed;
    b.roadObjects[0].position = { x: a.roadObjects[0].position.x, y: -a.roadObjects[0].position.y };
    const ta = a.truth(), tb = b.truth();
    for (let c = 8; c < 13; c += 1) expect(tb[c], ESTIMATE_NAMES[c]).toBeCloseTo(ta[c] * MIRROR_SIGN[c], 5);
    expect(ta[8]).toBeGreaterThan(0.3);
  });

  it("mirrors the domain's own estimate vector", () => {
    const out = new Array(13).fill(0); const values = ESTIMATE_NAMES.map((_, i) => 0.1 * (i + 1));
    trackDomain.mirror(values, out);
    out.forEach((v, i) => expect(v).toBeCloseTo(values[i] * MIRROR_SIGN[i], 9));
  });

  it("flips the open world's clearance sectors end to end", () => {
    const a = new WorldEpisode({ seed: 5, density: 0.9, headless: true });
    a.sim.kart.x = 40; a.sim.kart.y = -30; a.sim.kart.heading = 0.4;
    // Mirror the whole world across the x axis.
    const b = new WorldEpisode({ seed: 5, density: 0.9, headless: true });
    b.sim.world.obstacles.forEach((o, i) => { o.x = a.sim.world.obstacles[i].x; o.y = -a.sim.world.obstacles[i].y; });
    b.sim.world.patches.forEach((p, i) => { p.x = a.sim.world.patches[i].x; p.y = -a.sim.world.patches[i].y; });
    b.sim.kart.x = a.sim.kart.x; b.sim.kart.y = -a.sim.kart.y; b.sim.kart.heading = -a.sim.kart.heading;
    const ta = a.truth(), tb = b.truth(); const mirrored = new Array(10).fill(0);
    worldDomain.mirror(ta, mirrored);
    mirrored.forEach((v, i) => expect(tb[i]).toBeCloseTo(v, 4));
  });
});
