// The physical robot FlyKart Vision is being scaled to, and the sensors on it.
//
// Real robot (the target):
//   26 cm long, 17 cm wide, wheel centre to wheel centre 11.5 cm,
//   body 6.5 cm above the floor, where the camera and the sonar are mounted.
// Simulated kart: 24 x 14 px. One pixel is therefore taken to be 1.1 cm
// (24 px = 26.4 cm long, 14 px = 15.4 cm wide, within 10 % of the robot), which
// puts the top speed (90 px/s) at about 1 m/s. The kart's handling is the
// original FlyKart's; nothing here claims the real robot drives the same.
import { CameraConfig, DEFAULT_CAMERA } from "./camera";

export const CM_PER_PIXEL = 1.1;
export const ROBOT = { lengthCm: 26, widthCm: 17, wheelbaseCm: 11.5, mountHeightCm: 6.5 } as const;
export const toPixels = (centimetres: number): number => centimetres / CM_PER_PIXEL;
export const toCentimetres = (pixels: number): number => pixels * CM_PER_PIXEL;

/** Where the sensors sit on the body, in simulation pixels. */
export const MOUNT = { height: toPixels(ROBOT.mountHeightCm), forward: 11 };

export const profileById = (id: string | undefined): SensorProfile => (id === "robot" ? ROBOT_PROFILE : KART_PROFILE);

/** The wide, low-resolution eye on the robot: 48x24 colour, 6.5 cm above the floor. */
export const ROBOT_CAMERA: CameraConfig = { width: 48, height: 24, hfov: (100 * Math.PI) / 180, mountHeight: MOUNT.height, pitch: 0.12, mountForward: MOUNT.forward };
export const ROBOT_WORLD_CAMERA: CameraConfig = { ...ROBOT_CAMERA, hfov: (104 * Math.PI) / 180 };

/**
 * An HC-SR04 ultrasonic ranger, with the limits of the cheap module and not the
 * idealised "distance to the nearest thing ahead".
 */
export type SonarSpec = {
  /** Datasheet range: 2 cm to 400 cm. */
  minRangeCm: number; maxRangeCm: number;
  /** Width of the main lobe (Gaussian sigma, degrees): about 15 degrees of useful beam. */
  lobeSigmaDeg: number;
  /** Ticks between pings (the module needs about 60 ms between them to avoid hearing its own echoes). */
  cycleTicks: number;
  /** Height of the transducers above the floor, and how far in front of the kart's centre they sit (px). */
  mountHeight: number; mountForward: number;
  /** Range noise: sigma = base + proportional * range (cm), and the timer's resolution (cm). */
  noiseBaseCm: number; noiseProportional: number; resolutionCm: number;
  /** The speed of sound drifts with air temperature; this is the per-run spread of the resulting scale error. */
  soundScaleSigma: number;
  /** Echo strength below which nothing is heard, and the spread of echo strength from ping to ping. */
  threshold: number; speckleSigma: number;
  /** Chance per ping of a false reading (crosstalk, a stray echo). */
  ghostProbability: number;
};

export const HC_SR04: SonarSpec = {
  minRangeCm: 2, maxRangeCm: 400, lobeSigmaDeg: 12, cycleTicks: 2, mountHeight: MOUNT.height, mountForward: MOUNT.forward,
  noiseBaseCm: 0.35, noiseProportional: 0.004, resolutionCm: 0.3, soundScaleSigma: 0.015, threshold: 0.012, speckleSigma: 0.3, ghostProbability: 0.004,
};

/** What the controller reads from a sonar: how close the echo is, and how strong. */
export const SONAR_INPUTS = 2;
/** The sonar's controller inputs saturate here; beyond it the module is too unreliable to act on. */
export const SONAR_USEFUL_RANGE_PX = 200;

/**
 * Sensors available on a given robot. "kart" is FlyKart Vision as first built (a camera 16 cm up, no sonar);
 * "robot" is the scaled, physically realistic sensor head.
 */
export type SensorProfile = {
  id: "kart" | "robot";
  title: string;
  /** The eye on the track, and in the open world (a little wider). */
  camera: CameraConfig; worldCamera: CameraConfig;
  /** Height of the gate gantries. The sonar looks along the floor, so on the robot track they must clear its beam. */
  gantry: { z0: number; z1: number };
  sonar: SonarSpec | null;
};

export const KART_PROFILE: SensorProfile = { id: "kart", title: "Simulated kart · camera only", camera: DEFAULT_CAMERA, worldCamera: { ...DEFAULT_CAMERA, hfov: (104 * Math.PI) / 180 }, gantry: { z0: 14, z1: 19 }, sonar: null };
export const ROBOT_PROFILE: SensorProfile = { id: "robot", title: "Robot scale · camera + HC-SR04 sonar", camera: ROBOT_CAMERA, worldCamera: ROBOT_WORLD_CAMERA, gantry: { z0: 36, z1: 42 }, sonar: HC_SR04 };
