import { RobotConfig, Wiring, wiringIssues } from "./model";
import { Patchboard } from "./patchboard";
import type { SignalName } from "./rewiring";

// Espressif CameraWebServer AI-Thinker mapping. GPIO numbers, not FPC positions.
export const CAMERA_PINS = [
  ["XCLK", 0], ["SIOD / SDA", 26], ["SIOC / SCL", 27],
  ["Y2 / D0", 5], ["Y3 / D1", 18], ["Y4 / D2", 19], ["Y5 / D3", 21],
  ["Y6 / D4", 36], ["Y7 / D5", 39], ["Y8 / D6", 34], ["Y9 / D7", 35],
  ["VSYNC", 25], ["HREF", 23], ["PCLK", 22], ["PWDN", 32],
] as const;
type Signal = "in1" | "in2" | "in3" | "in4" | "ena" | "enb" | "trig" | "echo";
type State = "ok" | "note" | "error" | "off";
export type WireConnection = { id: string; name: string; from: string; to: string; colour: string; detail: string; state: State; pin?: number };
const SIGNALS: Signal[] = ["in1", "in2", "in3", "in4", "ena", "enb", "trig", "echo"];
const COLOURS: Record<string, string> = { in1: "#83ccb2", in2: "#a4dc8a", in3: "#7bbce4", in4: "#a1a5ee", ena: "#d1afed", enb: "#dcaacb", trig: "#e9ba73", echo: "#eeb48e", camera: "#bc9ae4", left: "#edce76", right: "#e6a578", supply: "#e08f80", logic: "#eaa29c", ground: "#a2b6c1" };
const escaped = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const pinLabel = (w: Wiring, pin: number) => pin < 0 ? "Unconnected" : `${w.board === "uno" ? pin >= 14 ? "A" + (pin - 14) : "D" + pin : "GPIO " + pin}`;

export function wiringConnections(w: Wiring, c: RobotConfig): WireConnection[] {
  const isEsp = w.board === "esp32-cam", logic = isEsp ? "3.3 V" : "5 V";
  const counts = new Map<number, number>(); SIGNALS.forEach(k => { if (w[k] >= 0) counts.set(w[k], (counts.get(w[k]) ?? 0) + 1); });
  if((w.vibration??-1)>=0)counts.set(w.vibration!, (counts.get(w.vibration!)??0)+1);
  const reserved: number[] = [...CAMERA_PINS.map(([, pin]) => pin), 16, 17];
  const detail: Record<Signal, string> = {
    in1: "Channel A direction input 1. With ENA jumpered, analogWrite on IN1 requests forward PWM for both left motors.",
    in2: "Channel A direction input 2. PWM here reverses both left motors; the sketch normally holds IN1 low while reversing.",
    in3: "Channel B direction input 1. Both right motors share this PWM / direction input.",
    in4: "Channel B direction input 2. Both right motors reverse together when this input receives PWM.",
    ena: "Channel A enable. A value of −1 means the module's ENA jumper connects it to logic HIGH; no controller wire exists. A GPIO assignment replaces that jumper with a PWM enable wire.",
    enb: "Channel B enable. A value of −1 means the ENB jumper is fitted. Remove the corresponding enable jumper when using a GPIO for enable PWM.",
    trig: "Controller output → HC-SR04 TRIG. The sketch generates a ≥10 µs trigger. The sensor is powered from the regulated 5 V rail; verify that your particular module accepts the controller's logic level.",
    echo: isEsp && w.echoDivider ? "HC-SR04 ECHO → level shifter / resistor divider → ESP32 input. Example divider: ECHO → 10 kΩ → node → 15 kΩ → GND; node → GPIO (about 3.0 V from a 5 V echo). pulseIn reads width, not echo amplitude." : isEsp ? "The 5 V ECHO is connected directly to an ESP32 GPIO. Enable ECHO level shifting in Components & wiring; this configuration inhibits virtual motors." : "HC-SR04's 5 V ECHO can connect to the UNO's 5 V input. pulseIn measures its duration; a zero duration is an unknown distance.",
  };
  const nets = SIGNALS.map((key): WireConnection => {
    const pin = w[key], jumper = (key === "ena" || key === "enb") && pin < 0;
    const target = key === "trig" || key === "echo" ? `HC-SR04 ${key.toUpperCase()}` : `L298N ${key.toUpperCase()}`;
    let state: State = "ok", note = "";
    if (!jumper && (!Number.isInteger(pin) || pin < 0 || (isEsp ? ![1, 2, 3, 4, 12, 13, 14, 15].includes(pin) : pin > 19))) { state = "error"; note = reserved.includes(pin) && isEsp ? " Camera / PSRAM GPIO conflict." : " Pin is not available in this board profile."; }
    if (pin >= 0 && (counts.get(pin) ?? 0) > 1) { state = "error"; note += " This GPIO is assigned to more than one signal."; }
    if (isEsp && w.sdCard && [2, 4, 12, 13, 14, 15].includes(pin)) { state = "error"; note += " SD interface conflict."; }
    if (key === "echo" && isEsp && !w.echoDivider) state = "error";
    if (state === "ok" && isEsp && [1, 2, 3, 4, 12, 15].includes(pin)) { state = "note"; note += pin === 4 ? " GPIO4 shares the onboard flash LED." : pin === 1 || pin === 3 ? " This pin shares the programming UART." : " Check boot strap levels on power-up; GPIO12 must not be pulled high at boot."; }
    if ((key === "trig" || key === "echo") && !c.sonarEnabled) state = "off";
    return { id: key, name: key.toUpperCase(), pin: jumper ? undefined : pin, from: jumper ? `${key.toUpperCase()} jumper · logic HIGH` : key === "echo" ? "HC-SR04 ECHO · 5 V" : `${isEsp ? "ESP32" : "UNO"} ${pinLabel(w, pin)}`, to: key === "echo" ? `${pinLabel(w, pin)}${isEsp && w.echoDivider ? " via level shifter" : ""}` : target, colour: COLOURS[key], detail: `${detail[key]} ${key === "echo" ? "" : `Controller logic: ${logic}.`}${note}`, state };
  });
  const vp=w.vibration??-1,ve=!!c.vibration?.enabled;
  return [...nets,
    {id:"vibration",name:"SW-420 DO",from:"SW-420 digital comparator output",to:pinLabel(w,vp),colour:"#f6a7d3",detail:"DO switches 0/1 on vibration, not collision force. Active polarity is configurable; verify the module at rest and during a tap. Short edges are captured by interrupt with debounce and held for the host. GPIO33 is a modified status-LED solder pad, not a normal header pin. Motors, cables and loose mounting can cause false triggers.",state:!ve?"off":vp<0?"note":(!Number.isInteger(vp)||(isEsp?![1,2,3,4,12,13,14,15,33].includes(vp):vp>19))||vp===33&&!c.vibration?.gpio33Access||[1,3].includes(vp)&&isEsp||nets.some(n=>n.pin===vp)?"error":"ok",pin:vp},
    {id:"vibration-power",name:"SW-420 VCC / GND",from:isEsp?"Controller 3.3 V output + common GND":"Controller 5 V + common GND",to:"SW-420 VCC / GND",colour:"#dba8cb",detail:"SW-420 module: 32 × 15 mm, 3.3–5 V supply, LM393 comparator. Use 3.3 V VCC with ESP32 so DO never supplies 5 V logic. Potentiometer sets hardware sensitivity. The drive-current description is not a voltage-tolerance specification.",state:!ve?"off":!w.commonGround?"error":"ok"},
    ...(isEsp ? [{ id:"uart", name:"USB serial", from:"USB-UART TX / RX · 3.3 V logic", to:"ESP32 GPIO3 RX / GPIO1 TX", colour:"#8cbdda", detail:"Optional USB tether / flashing connection: adapter TX goes to GPIO3 RX, adapter RX goes to GPIO1 TX, with shared GND. The UART adapter's logic must be 3.3 V. GPIO1/3 cannot simultaneously serve another component in the USB bridge. Board power remains the regulated 5 V rail. GPIO0 is grounded only for bootloader entry, then released before running the camera.", state:usedUart(w) ? "error" as State : "note" as State }] : []),
    { id: "camera", name: "Camera", from: isEsp ? "OV2640 · onboard ribbon" : "External camera / brain bridge", to: isEsp ? "ESP32 internal camera GPIOs" : "UNO · bridge interface unspecified", colour: COLOURS.camera, detail: isEsp ? "The OV2640 uses the onboard FPC ribbon, not spare jumper GPIOs. Its data, clock and control pins are reserved. The camera pin reference lists their exact AI-Thinker mapping. RESET is not GPIO-controlled in this profile." : "This legacy profile needs an external vision / brain bridge. No camera communication pins are assigned by the simulator; the dashed link indicates an unspecified interface.", state: !c.cameraEnabled ? "off" : isEsp ? "ok" : "note" },
    { id: "left", name: "Left wheels", from: "L298N OUT1 / OUT2", to: "Front-left + rear-left motors", colour: COLOURS.left, detail: "Two motors wired in parallel to channel A, with polarity chosen so both wheels drive the chassis forward together. These are bidirectional motor outputs, not 5 V logic or ground. Each motor's stall current contributes to the channel load.", state: "ok" },
    { id: "right", name: "Right wheels", from: "L298N OUT3 / OUT4", to: "Front-right + rear-right motors", colour: COLOURS.right, detail: "Two motors in parallel on channel B. Adjust physical motor polarity for the mirrored mounting, or use the software polarity adapter. The winding voltages depend on bridge switching and losses.", state: "ok" },
    { id: "supply", name: "Motor supply", from: `Motor supply · ${c.voltage} V setting`, to: "L298N VM / VS + regulator input", colour: COLOURS.supply, detail: "The voltage is the simulation's motor-supply setting, not a measured battery voltage. VM is often labelled +12V on modules; the terminal name does not require a 12 V supply. The supplied motors are rated 3–6 V. Confirm module ratings and motor stall-current requirements for your build.", state: c.voltage > 6 ? "note" : "ok" },
    { id: "logic", name: "5 V supply", from: "External regulated 5 V", to: `${isEsp ? "ESP32-CAM 5V input" : "UNO regulated 5V input"} + sonar VCC + L298N logic`, colour: COLOURS.logic, detail: "This schematic assumes a regulated external 5 V rail. Configure the L298N module's onboard regulator jumper for external logic power; its 5V-regulator jumper is separate from ENA/ENB. The ESP32-CAM uses its onboard 3.3 V regulator. Regulators and current delivery are not electrically simulated.", state: "note" },
    { id: "ground", name: "Common ground", from: "Supply / regulator GND", to: "Controller + HC-SR04 + L298N + level shifter", colour: COLOURS.ground, detail: w.commonGround ? "All logic circuits share the same reference ground. The motor windings connect to bridge outputs, not to this rail." : "The shared-ground link is marked open. Enable Shared ground in Components & wiring to restore a common logic reference; virtual motors are inhibited while it is absent.", state: w.commonGround ? "ok" : "error" },
  ];
}
const usedUart=(w:Wiring)=>[...SIGNALS.map(k=>w[k]),w.vibration??-1].some(p=>p===1||p===3);

function diagramSvg(w: Wiring, c: RobotConfig, nets: WireConnection[], selected: string): string {
  const t = (x: number, y: number, text: string, cls = "label", anchor = "start") => `<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}">${escaped(text)}</text>`;
  const box = (x: number, y: number, width: number, height: number, cls = "module") => `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="12" class="${cls}"/>`;
  const pad = (x: number, y: number) => `<circle cx="${x}" cy="${y}" r="5" class="pad"/>`;
  const wire = (id: string, paths: string[], forcedDash = false) => {
    const net = nets.find(n => n.id === id)!;
    return `<g class="wire${selected === id ? " selected" : ""}${net.state === "error" ? " bad-wire" : ""}${net.state === "off" ? " off-wire" : ""}" data-net="${id}" role="button" tabindex="0" aria-label="${escaped(`${net.name}: ${net.from} to ${net.to}`)}" style="--wire:${net.state === "error" ? "#ef9288" : net.colour}"><title>${escaped(`${net.from} → ${net.to}. ${net.detail}`)}</title>${paths.map(d => `<path d="${d}" class="wire-hit"/><path d="${d}" class="wire-line"${forcedDash || net.state === "off" || net.state === "error" ? ' stroke-dasharray="7 5"' : ""}/>`).join("")}</g>`;
  };
  const isEsp = w.board === "esp32-cam";
  let paths = SIGNALS.map((key, i) => {
    const y = 188 + i * 36;
    if ((key === "ena" || key === "enb") && w[key] < 0) return wire(key, [`M620 ${y} H690`]);
    if (key === "trig") return wire(key, ["M350 404 H455 V500 H690"]);
    if (key === "echo") return wire(key, isEsp && w.echoDivider ? ["M690 550 H635", "M495 550 H410 V440 H350"] : ["M690 550 H410 V440 H350"]);
    return wire(key, [`M350 ${y} H690`]);
  }).join("");
  paths += wire("camera", ["M200 490 V530"], !isEsp);
  if(isEsp)paths+=wire("uart",["M80 205 H60 V60 H385 V115 H410","M80 230 H45 V70 H400 V145 H410"]);
  paths += wire("left", ["M940 190 H975 V135 H1015", "M975 190 V205 H1015", "M940 225 H995 V155 H1015", "M995 225 H1015"]);
  paths += wire("right", ["M940 280 H975 V355 H1015", "M975 355 V425 H1015", "M940 315 H995 V375 H1015", "M995 375 V445 H1015"]);
  paths += wire("supply", ["M285 708 H380", "M315 708 V635 H665 V430 H835 V405"]);
  paths += wire("logic", ["M580 708 H610 V650", "M80 350 H50 V650 H955 V405 H900", "M900 615 V650"]);
  paths += wire("ground", ["M80 400 H30 V795 H955", "M180 760 V795", "M480 760 V795", "M755 405 H655 V795", "M735 615 V795", ...(isEsp ? ["M500 165 H670 V795"] : []), ...(isEsp && w.echoDivider ? ["M565 595 H645 V795"] : [])], !w.commonGround);

  const board = box(80, 90, 270, 400, "board") + t(98, 118, isEsp ? "ESP32-CAM" : "ARDUINO UNO", "title") + t(98, 139, isEsp ? "AI-THINKER / 3.3 V GPIO" : "LEGACY PROFILE / 5 V GPIO", "caption") +
    `<path d="M110 166 h76 v8 h-64 v8 h64 v8 h-64 v8 h64" class="antenna"/>` + box(105, 250, 100, 75, "chip") + t(155, 279, isEsp ? "ESP32" : "ATmega", "label", "middle") + t(155, 302, isEsp ? "PSRAM" : "328P", "caption", "middle") +
    SIGNALS.map((key, i) => { const jumper = (key === "ena" || key === "enb") && w[key] < 0; return (jumper ? "" : pad(350, 188 + i * 36)) + t(334, 192 + i * 36, jumper ? `${key.toUpperCase()} → DRIVER` : `${pinLabel(w, w[key])} · ${key.toUpperCase()}`, "pin", "end"); }).join("") +
    (isEsp ? pad(80,205)+t(96,209,"GPIO1 TX","pin")+pad(80,230)+t(96,234,"GPIO3 RX","pin") : "") +
    pad(350,476)+t(334,480,`SW-420 ${pinLabel(w,w.vibration??-1)}`,"caption","end")+pad(80,375)+t(96,379,isEsp?"3.3V OUTPUT":"5V OUTPUT","pin")+pad(80, 350) + t(96, 354, "5V INPUT", "pin") + pad(80, 400) + t(96, 404, "GND", "pin") +
    t(98, 461, isEsp ? w.sdCard ? "SD ACTIVE · GPIO SHARING" : "SD DISABLED · PINS AVAILABLE" : "EXTERNAL CAMERA BRIDGE", "caption") + pad(200, 490);
  paths+=wire("vibration",["M350 476 H370 V502 H410"],(w.vibration??-1)<0)+wire("vibration-power",["M80 375 H60 V660 H390 V472 H410","M410 519 H380 V795 H480"]);
  const vibration=box(410,430,230,95,"sonar-module")+t(430,452,"SW-420 · LM393","label")+pad(410,472)+t(425,476,isEsp?"VCC 3.3 V":"VCC 5 V","caption")+pad(410,502)+t(425,506,c.vibration?.enabled?"DO · DIGITAL 0/1":"DO · DISABLED","caption")+pad(410,519)+t(425,523,"GND · 32 × 15 mm","caption");
  const driver = box(690, 90, 250, 315, "driver") + t(709, 118, "L298N", "title") + t(709, 138, "DUAL H-BRIDGE MODULE", "caption") +
    `<rect x="793" y="156" width="125" height="88" rx="5" class="heatsink"/>${Array.from({ length: 9 }, (_, i) => `<path d="M${805 + i * 12} 161 v78" class="fin"/>`).join("")}` +
    SIGNALS.slice(0, 6).map((key, i) => pad(690, 188 + i * 36) + t(704, 192 + i * 36, key.toUpperCase(), "pin")).join("") +
    [190, 225, 280, 315].map((y, i) => pad(940, y) + t(925, y - 8, `OUT${i + 1}`, "pin", "end")).join("") +
    [[755, "GND"], [835, "VM"], [900, "5V LOGIC"]].map(([x, name]) => pad(Number(x), 405) + t(Number(x), 390, String(name), "caption", "middle")).join("");
  const jumpers = ["ena", "enb"].map((key, i) => w[key as Signal] < 0 ? box(538, 316 + i * 36, 82, 28, "jumper") + t(579, 335 + i * 36, `${key.toUpperCase()} HIGH`, "caption", "middle") : "").join("");
  const motor = (y: number, side: string) => box(1015, y, 195, 190, "motor-group") + t(1033, y + 23, `${side} WHEELS`, "label") +
    [45, 115].map((dy, i) => `${pad(1015, y + dy)}${pad(1015, y + dy + 20)}<circle cx="1106" cy="${y + dy + 10}" r="24" class="motor"/>${t(1106, y + dy + 15, "M", "label", "middle")}${t(1143, y + dy + 8, i ? "REAR" : "FRONT", "caption")}`).join("") + t(1033, y + 173, "2 MOTOR WINDINGS IN PARALLEL", "caption");
  const camera = box(70, 530, 275, 100, "camera-module") + `<circle cx="117" cy="576" r="26" class="lens"/><circle cx="117" cy="576" r="12" class="lens-glass"/>` + t(160, 557, isEsp ? "OV2640 CAMERA" : "CAMERA BRIDGE", "label") + t(160, 579, isEsp ? "ONBOARD FPC RIBBON" : "INTERFACE UNSPECIFIED", "caption") + t(160, 599, c.cameraEnabled ? "160 × 120 · RGB565" : "DISCONNECTED", "caption") + pad(200, 530);
  const uart=isEsp ? box(410,75,235,90,"camera-module")+t(430,99,"USB-UART ADAPTER","label")+pad(410,115)+t(430,119,"RX ← ESP32 TX","caption")+pad(410,145)+t(430,149,"TX → ESP32 RX","caption")+pad(500,165)+t(623,119,"3.3 V","caption","end")+t(620,149,"GND ↓","caption","end") : "";
  const sonar = box(690, 455, 250, 160, "sonar-module") + t(709, 478, "HC-SR04", "title") + pad(690, 500) + t(706, 504, "TRIG", "pin") + pad(690, 550) + t(706, 554, "ECHO", "pin") +
    [835, 900].map(x => `<circle cx="${x}" cy="534" r="25" class="transducer"/><circle cx="${x}" cy="534" r="16" class="transducer-inner"/>`).join("") + t(709, 588, c.sonarEnabled ? "5 V POWER · 5 V ECHO" : "SENSOR DISCONNECTED", "caption") + pad(735, 615) + t(735, 605, "GND", "caption", "middle") + pad(900, 615) + t(900, 605, "VCC", "caption", "middle");
  const shift = isEsp && w.echoDivider ? box(495, 530, 140, 65, "shifter") + t(565, 550, "ECHO LEVEL SHIFT", "caption", "middle") + t(505, 578, "3 V GPIO", "caption") + t(624, 578, "5 V", "caption", "end") + pad(495, 550) + pad(635, 550) + pad(565, 595) : t(493, 540, isEsp ? "5 V DIRECT · INVALID" : "5 V ECHO → UNO", "caption");
  const power = box(80, 685, 205, 75, "power-module") + t(98, 710, "MOTOR SUPPLY", "label") + t(98, 735, `${c.voltage} V · SIMULATION SETTING`, "caption") + pad(285, 708) + pad(180, 760) +
    box(380, 685, 200, 75, "power-module") + t(398, 710, "5 V REGULATOR", "label") + t(398, 735, "EXTERNAL · ASSUMED", "caption") + pad(380, 708) + pad(580, 708) + pad(480, 760) +
    t(865, 639, "REGULATED 5 V RAIL", "caption") + t(80, 821, w.commonGround ? "COMMON REFERENCE GROUND" : "GROUND LINK OPEN · MOTOR INHIBIT", "caption");
  // Junction dots distinguish joined branches from simple wire crossings.
  const junctions = [[975, 190], [995, 225], [975, 355], [995, 375], [315, 708], [610, 650], [900, 650], [180, 795], [480, 795], [655, 795], [735, 795], ...(isEsp?[[670,795]]:[]), ...(isEsp && w.echoDivider ? [[645, 795]] : [])].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3.5" fill="#d5ded7"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1240 850" role="img" aria-label="Robot wiring diagram for ${isEsp ? "ESP32-CAM" : "Arduino UNO"}"><title>Robot pinout and component connections</title><desc>Logical connections, not physical header orientation. Select a wire to inspect its pin assignment.</desc><style>
    text{font-family:Consolas,monospace;fill:#dce9e0}.title{font-size:18px;font-weight:bold}.label{font-size:13px}.pin{font-size:12px}.caption{font-size:10px;fill:#9ab4af}.module,.board,.driver,.camera-module,.sonar-module,.motor-group,.power-module,.shifter,.jumper{fill:#182e33;stroke:#49615f;stroke-width:1.5}.board{fill:#213e36}.driver{fill:#353630}.motor-group{fill:#252e31}.power-module{fill:#312f2c}.chip,.heatsink{fill:#0d1a20;stroke:#4b5e62}.fin{stroke:#5b6b6d;stroke-width:4}.pad{fill:#d6c58b;stroke:#102127;stroke-width:2}.antenna{fill:none;stroke:#d6c58b;stroke-width:3}.lens{fill:#131f24;stroke:#94ada7;stroke-width:2}.lens-glass{fill:#3c656c;stroke:#b1c4bb}.transducer{fill:#a5b7b2;stroke:#536e70;stroke-width:3}.transducer-inner{fill:#3d555b;stroke:#8da5a7;stroke-width:3}.motor{fill:#666045;stroke:#d5c079;stroke-width:2}.wire{cursor:pointer;outline:none}.wire-hit{stroke:transparent;stroke-width:17;fill:none}.wire-line{stroke:var(--wire);stroke-width:2.7;stroke-linecap:round;stroke-linejoin:round;fill:none}.wire:hover .wire-line,.wire:focus .wire-line,.wire.selected .wire-line{stroke-width:5}.off-wire{opacity:.4}.jumper{fill:#473d40}.shifter{fill:#333745}
  </style><rect width="1240" height="850" rx="14" fill="#0d1c23"/>${t(30, 31, "ROBOT / CONNECTION MAP", "label")}${t(30, 52, "LOGICAL GPIO BREAKOUT · NOT PHYSICAL HEADER ORDER · DOTS JOIN WIRES", "caption")}${paths}${board}${driver}${jumpers}${motor(90, "LEFT")}${motor(310, "RIGHT")}${camera}${uart}${vibration}${sonar}${shift}${power}${junctions}</svg>`;
}

export class WiringDiagram {
  private w!: Wiring; private c!: RobotConfig; private nets: WireConnection[] = []; private selected = "echo";
  private patchHost = document.createElement("div"); private patch: Patchboard;
  private connect: ((signal: SignalName, pin: number) => void) | null = null;
  constructor(private host: HTMLElement) {
    this.patch = new Patchboard(this.patchHost, (signal, pin) => this.connect?.(signal, pin));
    const select = (event: Event) => { const target = (event.target as Element).closest<HTMLElement>("[data-net]"); if (!target || !host.contains(target)) return; this.selected = target.dataset.net!; this.selectWire(); };
    host.addEventListener("click", select);
    host.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { if ((event.target as Element).closest("[data-net]")) { event.preventDefault(); select(event); } } });
  }
  enableEditing(callback: (signal: SignalName, pin: number) => void): void { this.connect = callback; }
  update(w: Wiring, c: RobotConfig, draft = false): void {
    this.w = { ...w }; this.c = { ...c }; this.nets = wiringConnections(w, c);
    const issues = wiringIssues(w);
    this.host.innerHTML = `<div class="wiring-diagram-heading"><div><strong>${w.board === "esp32-cam" ? "ESP32-CAM → robot components" : "UNO → robot components"}</strong><p>${draft ? "DRAFT · preview of the fields below; Apply components activates these assignments." : "APPLIED · current component and pin assignments."}</p></div><span class="wiring-state ${issues.errors.length ? "invalid" : ""}">${issues.errors.length ? "MOTOR INHIBIT" : "CONNECTIONS VALID"}</span></div><div class="wire-legend"><span style="--swatch:#83ccb2">Motor control</span><span style="--swatch:#e9ba73">Sonar</span><span style="--swatch:#bc9ae4">Camera ribbon</span><span style="--swatch:#eaa29c">Power</span><span style="--swatch:#a2b6c1">Ground</span><small>Tap / click a wire · dashed = disconnected, invalid or unspecified</small></div><div class="wire-viewport" tabindex="0" aria-label="Scrollable component wiring diagram">${diagramSvg(w, c, this.nets, this.selected)}</div><div class="wire-detail" aria-live="polite"></div><details class="wire-netlist"><summary>Connection list · ${this.nets.length} nets</summary><div class="wire-net-grid">${this.nets.map(n => `<button type="button" data-net="${n.id}" class="wire-net ${n.state}"><i style="background:${n.colour}"></i><strong>${escaped(n.name)}</strong><span>${escaped(n.from)} → ${escaped(n.to)}</span><small data-reading="${n.id}"></small></button>`).join("")}</div></details><details class="pin-reference"><summary>${w.board === "esp32-cam" ? "ESP32-CAM GPIO & camera pin reference" : "UNO pin reference & camera bridge"}</summary>${this.pinReference()}</details><p class="wire-assumptions">Logical wiring, not module-header orientation. The power rail and regulator are illustrative; the simulator does not calculate electrical currents or supply faults. ${w.board === "uno" ? "This profile connects UNO to L298N. The OSOYOO L293D/WiFi shield is not mapped in this diagram." : "The direct ESP32 profile omits the UNO and OSOYOO shield."}</p><p class="wire-sources">Pin references: <a href="https://github.com/espressif/arduino-esp32/blob/master/libraries/ESP32/examples/Camera/CameraWebServer/camera_pins.h" target="_blank" rel="noreferrer">Espressif camera mapping ↗</a> · <a href="https://cdn.sparkfun.com/datasheets/Sensors/Proximity/HCSR04.pdf" target="_blank" rel="noreferrer">HC-SR04 datasheet ↗</a> · <a href="https://www.st.com/resource/en/datasheet/l298.pdf" target="_blank" rel="noreferrer">ST L298 datasheet ↗</a></p>`;
    if (this.connect && !draft) { this.host.querySelector(".wire-legend")!.before(this.patchHost); this.patch.update(w, c); const jump=document.createElement("button");jump.textContent="All components ↓";jump.addEventListener("click",()=>this.host.querySelector(".component-overview")!.scrollIntoView({block:"start"}));this.patchHost.querySelector(".patch-heading")!.append(jump); }
    const overview = document.createElement("div"); overview.className = "component-overview";
    overview.innerHTML = '<span><b>1 · Controller</b>Camera capture + GPIO logic</span><span><b>2 · Sonar</b>TRIG out · shifted ECHO in</span><span><b>3 · Driver</b>Two winding pairs · four motors</span><span><b>4 · Power</b>Motor rail · regulated 5 V · shared GND</span>';
    this.host.querySelector(".wire-legend")!.before(overview);
    const isolate = document.createElement("label"); isolate.className = "check isolate-control"; isolate.innerHTML = '<input type="checkbox" class="isolate-wire"> Highlight selected wire only';
    isolate.addEventListener("change",()=>this.host.classList.toggle("isolate-nets", isolate.querySelector<HTMLInputElement>("input")!.checked));
    this.host.querySelector(".wire-legend")!.append(isolate); this.host.classList.remove("isolate-nets");
    this.selectWire();
  }
  private pinReference(): string {
    if (this.w.board === "uno") return '<p class="wire-assumptions">Digital D0–D13 and A0–A5 (numeric 14–19) use 5 V logic. D0/D1 share the UART; standard PWM outputs are D3, D5, D6, D9, D10 and D11. Use the connection list for the selected pins. Camera data requires an external bridge; its interface is not configured here.</p>';
    const refs: [number, string][] = [[1, "UART TX"], [2, "Boot strap · SD"], [3, "UART RX"], [4, "Flash LED · SD"], [12, "Boot strap · SD"], [13, "SD"], [14, "SD"], [15, "Boot strap · SD"]];
    return `<div class="pin-reference-grid"><section><h4>Exposed spare GPIOs · 3.3 V logic</h4><div class="gpio-reference">${refs.map(([pin, note]) => { const assigned = SIGNALS.filter(k => this.w[k] === pin); return `<div class="gpio-pin${assigned.length > 1 || this.w.sdCard && pin !== 1 && pin !== 3 ? " conflict" : ""}"><b>GPIO ${pin}</b><span>${assigned.map(k => k.toUpperCase()).join(" + ") || "Unassigned"}</span><small>${note}</small></div>`; }).join("")}</div><p>GPIO0 is exposed but reserved for camera XCLK and boot mode. GPIO16/17 serve PSRAM. Power pins are 5V input, onboard 3V3 and GND. Header order depends on module orientation: match printed labels.</p></section><section><h4>OV2640 · internal ribbon connections</h4><div class="camera-pin-grid">${CAMERA_PINS.map(([signal, pin]) => `<div><span>${signal}</span><b>GPIO ${pin}</b></div>`).join("")}</div><p>Camera RESET: −1 (no GPIO). These are ESP32 signal assignments, not FPC contact numbers. The ribbon stays onboard.</p></section></div>`;
  }
  private selectWire(): void {
    this.host.querySelectorAll("[data-net]").forEach(item => item.classList.toggle("selected", (item as HTMLElement).dataset.net === this.selected));
    const net = this.nets.find(n => n.id === this.selected)!;
    this.host.querySelector(".wire-detail")!.innerHTML = `<div><b style="color:${net.colour}">${escaped(net.name)}</b><span class="wire-detail-state ${net.state}">${net.state === "note" ? "SHARED / CHECK NOTES" : net.state.toUpperCase()}</span><small data-reading="${net.id}"></small></div><p class="wire-endpoints">${escaped(net.from)} → ${escaped(net.to)}</p><p>${escaped(net.detail)}</p>`;
  }
  live(pins: Map<number, number>, echoUs: number): void {
    this.host.querySelectorAll<HTMLElement>("[data-reading]").forEach(label => { const id = label.dataset.reading!, net = this.nets.find(n => n.id === id)!; label.textContent = id === "echo" ? this.c.sonarEnabled ? `Held ECHO: ${Math.round(echoUs)} µs` : "Sensor off" : net.pin !== undefined && SIGNALS.includes(id as Signal) ? `Last write: ${Math.round(pins.get(net.pin) ?? 0)} / 255` : ""; });
  }
  exportSvg(): string { return diagramSvg(this.w, this.c, this.nets, this.selected); }
}
