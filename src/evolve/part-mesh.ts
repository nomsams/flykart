// Building Three.js meshes from the same parts the simulator collides with and the sonar hears.
// Used by the Evolve page's 3D preview and by the robot habitat, so a scene looks the same in both.
import * as THREE from "three";
import type { PropPart } from "../vision/world/objects";
import type { WorldDef, Surface } from "../vision/world/world";
import { CM_PER_PIXEL } from "../vision/robot";

/** World pixels to metres. */
export const PX = CM_PER_PIXEL / 100;

const rgbHex = (c: [number, number, number] | undefined): number => {
  const [r, g, b] = c ?? [0.6, 0.6, 0.6];
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
};

/** One part: its footprint, its height interval, its colour. Boxes and (twelve-sided) cylinders. */
export function partMesh(p: PropPart, materials: Map<string, THREE.Material>): THREE.Mesh {
  const hex = rgbHex(p.color), foliage = p.sonarSurface === "foliage", soft = p.sonarSurface === "soft";
  const key = `${hex}:${foliage ? 1 : 0}:${soft ? 1 : 0}`;
  let material = materials.get(key);
  if (!material) {
    material = new THREE.MeshStandardMaterial({ color: hex, roughness: foliage ? 1 : soft ? 0.95 : 0.7, metalness: p.color && p.color[0] > 0.68 && p.color[1] > 0.7 && p.color[2] > 0.72 ? 0.5 : 0.02, flatShading: foliage });
    materials.set(key, material);
  }
  const height = Math.max(0.002, (p.z1 - p.z0) * PX);
  const geometry = p.shape === "cyl"
    ? new THREE.CylinderGeometry(p.halfLength * PX, p.halfLength * PX * (foliage ? 0.85 : 1), height, foliage ? 9 : 14)
    : new THREE.BoxGeometry(p.halfLength * 2 * PX, height, p.halfWidth * 2 * PX);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(p.x * PX, ((p.z0 + p.z1) / 2) * PX, p.y * PX);
  mesh.rotation.y = -(p.heading ?? 0);
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

const FLOOR_STYLE: Record<Exclude<Surface, "water">, { base: string; line?: string; cell?: number; plank?: boolean }> = {
  grass: { base: "#4f9a4a" }, sand: { base: "#d8c48a" }, mud: { base: "#7b5b38" },
  asphalt: { base: "#44474c" }, pavement: { base: "#b4b3ad", line: "#8f8e88", cell: 36 },
  parquet: { base: "#c99a63", line: "#a67a45", cell: 9, plank: true }, tile: { base: "#4a4d52", line: "#2c2e31", cell: 27 }, carpet: { base: "#9c5f58" },
};

function floorTexture(kind: Surface): THREE.CanvasTexture {
  const style = FLOOR_STYLE[kind === "water" ? "grass" : kind], size = 256, canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = kind === "water" ? "#2f78b8" : style.base; ctx.fillRect(0, 0, size, size);
  if (style.line && style.cell) {
    ctx.strokeStyle = style.line; ctx.lineWidth = 2;
    const step = style.plank ? size / 5 : size / (size / 8);
    if (style.plank) {
      for (let y = 0; y < size; y += size / 14) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.stroke(); }
      for (let row = 0; row < 14; row += 1) { const x = ((row * 37) % 90) / 90 * size; ctx.beginPath(); ctx.moveTo(x, (row * size) / 14); ctx.lineTo(x, ((row + 1) * size) / 14); ctx.stroke(); }
    } else {
      for (let k = 0; k <= 2; k += 1) { const p = (k * size) / 2; ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke(); }
    }
    void step;
  } else if (kind === "grass") {
    for (let i = 0; i < 700; i += 1) { ctx.fillStyle = Math.random() < 0.5 ? "#468c42" : "#59a653"; ctx.fillRect(Math.random() * size, Math.random() * size, 2, 2); }
  } else if (kind === "asphalt") {
    for (let i = 0; i < 500; i += 1) { ctx.fillStyle = Math.random() < 0.5 ? "#3b3e42" : "#505358"; ctx.fillRect(Math.random() * size, Math.random() * size, 2, 2); }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Floors, patches, props and the boundary of a world, as one group. */
export function buildWorldGroup(world: WorldDef): THREE.Group {
  const group = new THREE.Group(), materials = new Map<string, THREE.Material>();
  const textures = new Map<Surface, THREE.CanvasTexture>();
  const plane = (kind: Surface, x0: number, y0: number, x1: number, y1: number, lift: number): void => {
    let texture = textures.get(kind);
    if (!texture) { texture = floorTexture(kind); textures.set(kind, texture); }
    const t = texture.clone(); t.needsUpdate = true;
    const w = (x1 - x0) * PX, d = (y1 - y0) * PX;
    const tile = kind === "parquet" ? 0.45 : kind === "tile" ? 0.6 : kind === "pavement" ? 0.8 : 1.4;
    t.repeat.set(w / tile, d / tile);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ map: t, roughness: kind === "tile" ? 0.35 : 0.9 }));
    mesh.rotation.x = -Math.PI / 2; mesh.position.set(((x0 + x1) / 2) * PX, lift, ((y0 + y1) / 2) * PX); mesh.receiveShadow = true;
    group.add(mesh);
  };
  const h = world.half;
  plane(world.base ?? "grass", -h, -h, h, h, 0);
  let lift = 0.0005;
  for (const z of world.zones ?? []) { plane(z.kind, z.x0, z.y0, z.x1, z.y1, lift); lift += 0.0005; }
  for (const p of world.patches) {
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(p.radius * PX, 28), new THREE.MeshStandardMaterial({ color: p.kind === "water" ? 0x2f78b8 : p.kind === "mud" ? 0x6b4c2c : 0xd8c48a, roughness: p.kind === "water" ? 0.2 : 1 }));
    mesh.rotation.x = -Math.PI / 2; mesh.position.set(p.x * PX, lift, p.y * PX); mesh.receiveShadow = true; group.add(mesh); lift += 0.0005;
  }
  for (const o of world.obstacles) {
    if (o.parts) { for (const part of o.parts) group.add(partMesh(part, materials)); continue; }
    // Legacy kinds (the open world's original circles and slabs), kept recognisable.
    const parts: PropPart[] = [];
    if (o.kind === "tree") parts.push({ shape: "cyl", x: o.x, y: o.y, halfLength: o.radius, halfWidth: o.radius, z0: 0, z1: o.height, color: [0.34, 0.24, 0.15] }, { shape: "cyl", x: o.x, y: o.y, halfLength: o.radius * 3, halfWidth: o.radius * 3, z0: o.height * 0.55, z1: o.height * 1.15, color: [0.18, 0.5, 0.2], sonarSurface: "foliage" });
    else if (o.kind === "rock") parts.push({ shape: "cyl", x: o.x, y: o.y, halfLength: o.radius, halfWidth: o.radius, z0: 0, z1: o.height, color: [0.58, 0.57, 0.54] });
    else if (o.kind === "shoe") parts.push({ shape: "box", x: o.x, y: o.y, heading: o.tone * 3, halfLength: o.radius, halfWidth: o.radius * 0.42, z0: 0, z1: o.height, color: [0.62, 0.23, 0.12] });
    else if (o.kind === "cable") parts.push({ shape: "box", x: o.x, y: o.y, heading: o.tone * 3, halfLength: o.radius, halfWidth: 0.6, z0: 0, z1: 1, color: [0.08, 0.08, 0.09] });
    else if (o.kind === "mat") parts.push({ shape: "box", x: o.x, y: o.y, halfLength: o.radius, halfWidth: o.radius * 0.7, z0: 0, z1: 0.6, color: [0.58, 0.32, 0.23] });
    else parts.push({ shape: "box", x: o.x, y: o.y, halfLength: o.radius, halfWidth: o.radius * 0.8, z0: 0, z1: o.height, color: [0.55, 0.4, 0.25] });
    for (const part of parts) group.add(partMesh(part, materials));
  }
  // The boundary the camera sees: wall, kerb or fence.
  const style = world.boundary ?? "fence", top = style === "wall" ? 130 : style === "kerb" ? 12 : 11;
  for (const [x, y, hl, hw] of [[0, -h, h, 1.5], [0, h, h, 1.5], [-h, 0, 1.5, h], [h, 0, 1.5, h]] as const) {
    group.add(partMesh({ shape: "box", x, y, halfLength: hl, halfWidth: hw, z0: 0, z1: top, color: style === "wall" ? [0.93, 0.92, 0.88] : style === "kerb" ? [0.76, 0.76, 0.74] : [0.9, 0.9, 0.86] }, materials));
  }
  return group;
}

/** A small stand-in for the 26 x 17 cm robot with its camera and sonar, in metres. */
export function robotMesh(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.05, 0.17), new THREE.MeshStandardMaterial({ color: 0xf0e7cc, roughness: 0.6 }));
  body.position.y = 0.04; body.castShadow = true; g.add(body);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.0325, 0.0325, 0.027, 16), new THREE.MeshStandardMaterial({ color: 0x303435 }));
    wheel.rotation.x = Math.PI / 2; wheel.position.set(sx * 0.0575, 0.0325, sz * 0.082); g.add(wheel);
  }
  const eye = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.025, 0.04), new THREE.MeshStandardMaterial({ color: 0x17262d }));
  eye.position.set(0.115, 0.075, 0); g.add(eye);
  for (const z of [-0.025, 0.025]) { const s = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.012, 14), new THREE.MeshStandardMaterial({ color: 0xc2ced0 })); s.rotation.z = Math.PI / 2; s.position.set(0.13, 0.065, z); g.add(s); }
  return g;
}
