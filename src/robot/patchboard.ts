import type { RobotConfig, Wiring } from "./model";
import { availablePins, SignalName, SIGNAL_NAMES } from "./rewiring";

/** Actual spare GPIO pads, rather than one fictitious board pad per assigned signal. */
export class Patchboard {
  private signal: SignalName | null = null; private dragging = false; private svg: SVGSVGElement | null = null;
  constructor(private host: HTMLElement, private connect: (signal: SignalName, pin: number) => void) {
    host.addEventListener("pointerdown", event => {
      const target = (event.target as Element).closest<SVGElement>("[data-signal]"); if (!target) return;
      this.signal = target.dataset.signal as SignalName; this.dragging = true; this.highlight(); event.preventDefault();
    });
    host.addEventListener("pointermove", event => {
      if (!this.dragging || !this.signal || !this.svg) return;
      const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(this.svg.getScreenCTM()!.inverse());
      const port = this.host.querySelector<SVGCircleElement>(`[data-signal="${this.signal}"] circle`)!;
      this.host.querySelector(".patch-drag")!.setAttribute("d", `M${port.cx.baseVal.value} ${port.cy.baseVal.value} L${p.x} ${p.y}`);
    });
    window.addEventListener("pointerup", event => {
      if (!this.dragging) return; this.dragging = false;
      const pin = document.elementFromPoint(event.clientX, event.clientY)?.closest<SVGElement>("[data-gpio]");
      if (pin && this.host.contains(pin) && this.signal) this.connect(this.signal, Number(pin.dataset.gpio));
      this.host.querySelector(".patch-drag")?.setAttribute("d", "");
    });
    host.addEventListener("click", event => {
      const target = event.target as Element, signal = target.closest<SVGElement>("[data-signal]"), pin = target.closest<SVGElement>("[data-gpio]");
      if (signal) { this.signal = signal.dataset.signal as SignalName; this.highlight(); }
      if (pin && this.signal) this.connect(this.signal, Number(pin.dataset.gpio));
      const jumper = target.closest<HTMLElement>("[data-jumper]"); if (jumper) this.connect(jumper.dataset.jumper as SignalName, -1);
    });
    host.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { const t = event.target as Element; if (t.matches("[data-gpio],[data-signal]")) { event.preventDefault(); t.dispatchEvent(new MouseEvent("click", { bubbles: true })); } } });
  }
  update(w: Wiring, c: RobotConfig): void {
    const pins = availablePins(w.board), height = Math.max(570, pins.length * 38 + 125), yPin = (p: number) => 115 + pins.indexOf(p) * 38;
    const ports = SIGNAL_NAMES.map((signal, i) => {
      const y = 115 + i * 44, sensor = ["trig", "echo"].includes(signal);
      return `<g data-signal="${signal}" tabindex="0" role="button" aria-label="Connect ${signal.toUpperCase()}" class="patch-port"><rect x="554" y="${y - 17}" width="210" height="34" rx="6"/><circle cx="555" cy="${y}" r="7"/><text x="573" y="${y + 4}">${signal==="vibration"?"SW-420":sensor ? "HC-SR04" : "L298N"} ${signal.toUpperCase()}</text><text x="770" y="${y + 4}" class="patch-small">${(w[signal]??-1) < 0 ? signal==="vibration"?"disconnected":"jumper HIGH" : `GPIO ${w[signal]}`}${signal === "echo" && w.echoDivider ? " · shifted" : ""}</text></g>`;
    }).join("");
    const wires = SIGNAL_NAMES.filter(k => (w[k]??-1) >= 0 && pins.includes(w[k]!)).map((k,i) => `<path class="patch-wire" data-wire="${k}" d="M275 ${yPin(w[k]!)} C${355+i*9} ${yPin(w[k]!)} ${440+i*9} ${115+SIGNAL_NAMES.indexOf(k)*44} 555 ${115+SIGNAL_NAMES.indexOf(k)*44}" stroke="${["#83ccb2","#a4dc8a","#7bbce4","#a1a5ee","#d1afed","#dcaacb","#e9ba73","#eeb48e","#f6a7d3"][SIGNAL_NAMES.indexOf(k)]}"/>`).join("");
    this.host.innerHTML = `<div class="patch-heading"><div><h3>Reconnect GPIO wires</h3><p>Drag a component socket onto a GPIO. Or select a socket, then click a GPIO. Occupied GPIOs swap assignments; the sketch updates automatically.</p></div><span class="patch-choice" role="status">Select a component socket</span></div><div class="patch-viewport"><svg viewBox="0 0 970 ${height}" aria-label="Editable controller GPIO patchboard"><rect x="35" y="40" width="240" height="${height-65}" rx="12" class="patch-module"/><text x="55" y="68">${w.board === "esp32-cam" ? "ESP32-CAM · spare GPIOs" : "UNO · GPIOs"}</text><text x="55" y="88" class="patch-small">${w.board === "esp32-cam" ? "Camera & PSRAM pins reserved" : "Numeric 14–19 = A0–A5"}</text>${wires}${pins.map(pin => `<g data-gpio="${pin}" tabindex="0" role="button" aria-label="GPIO ${pin}" class="patch-pin"><rect x="53" y="${yPin(pin)-16}" width="222" height="32" rx="5"/><text x="67" y="${yPin(pin)+4}">GPIO ${pin}${pin===33?" · LED solder pad":""}</text><text x="153" y="${yPin(pin)+4}" class="patch-small">${SIGNAL_NAMES.filter(k=>w[k]===pin).map(k=>k.toUpperCase()).join(" + ") || "free"}</text><circle cx="275" cy="${yPin(pin)}" r="7"/></g>`).join("")}${ports}<path class="patch-drag"/><text x="555" y="${height-40}" class="patch-small">${c.sonarEnabled ? "ESP32 ECHO needs level shifting." : "Sonar disconnected."}</text><text x="555" y="${height-20}" class="patch-small">Camera ribbon and power: full map below.</text></svg></div><div class="patch-jumpers"><button data-jumper="vibration">Disconnect SW-420</button><button data-jumper="ena">Fit ENA jumper</button><button data-jumper="enb">Fit ENB jumper</button><small>Enable wires require removing the matching jumper. Power, ground, camera ribbon and motor winding pairs are separate nets in the full map.</small></div>`;
    this.svg = this.host.querySelector("svg"); this.highlight();
  }
  private highlight(): void {
    this.host.querySelectorAll<SVGElement>("[data-signal]").forEach(p=>p.classList.toggle("active",p.dataset.signal===this.signal));
    this.host.querySelectorAll<SVGElement>("[data-wire]").forEach(p=>{p.style.opacity = this.signal && p.dataset.wire!==this.signal ? ".2" : "1";});
    const choice=this.host.querySelector(".patch-choice"); if(choice) choice.textContent=this.signal ? `${this.signal.toUpperCase()} → choose a GPIO` : "Select a component socket";
  }
}
