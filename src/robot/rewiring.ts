import { RobotConfig, Wiring, wiringIssues } from "./model";
import { validateVibration } from './vibration';

/** Add only a free input; never take UART, motor, sonar or camera pins away. */
export function connectVibration(w:Wiring,c:RobotConfig):{wiring:Wiring;config:RobotConfig} {
  const settings=validateVibration(c.vibration);
  const used=new Set([w.in1,w.in2,w.in3,w.in4,w.ena,w.enb,w.trig,w.echo]);
  const candidates=w.board==='esp32-cam'?[2,4,12,13,14,15,33]:[4,11,12,13,14,15,16,17,18,19,2,3,5,6,7,8,9,10];
  const current=w.vibration??-1;
  const pin=candidates.includes(current)&&!used.has(current)?current:candidates.find(p=>!used.has(p));
  if(pin===undefined)throw new Error('No free SW-420 input. Free a GPIO in Components & wiring first.');
  const next={...w,vibration:pin},errors=wiringIssues(next).errors;
  if(errors.length)throw new Error(errors.join(' '));
  // Simulation can use GPIO33 without pretending that the physical pad is accessible.
  return{wiring:next,config:{...c,vibration:{...settings,enabled:true}}};
}

export const SIGNAL_NAMES = ["in1", "in2", "in3", "in4", "ena", "enb", "trig", "echo", "vibration"] as const;
export type SignalName = typeof SIGNAL_NAMES[number];
export const availablePins = (board: Wiring["board"]) => board === "esp32-cam" ? [1, 2, 3, 4, 12, 13, 14, 15, 33] : Array.from({ length: 20 }, (_, i) => i);

/** Move the occupied signal back to the dragged wire's old pin, preserving uniqueness. */
export function reconnect(w: Wiring, signal: SignalName, pin: number): Wiring {
  if (!availablePins(w.board).includes(pin) && !(pin === -1 && ["ena", "enb", "vibration"].includes(signal))) throw new Error("Choose an available GPIO or an enable jumper.");
  if(pin===33 && signal!=="vibration") throw new Error("GPIO33 is reserved for the optional modified-board SW-420 connection.");
  const next = { ...w }, old = w[signal] ?? -1;
  const occupied = SIGNAL_NAMES.find(k => k !== signal && next[k] === pin && pin >= 0);
  if (occupied) {
    if (old < 0 && !["ena", "enb", "vibration"].includes(occupied)) throw new Error(`${occupied.toUpperCase()} needs a GPIO. Choose an unused pin first.`);
    next[occupied] = old;
  }
  next[signal] = pin;
  const errors = wiringIssues(next).errors; if (errors.length) throw new Error(errors.join(" "));
  return next;
}

/** Only rewrite live numeric pin declarations; preserve comments, strings and the user's logic. */
export function rewritePins(source: string, w: Wiring): { source: string; changed: string[] } {
  const masked = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, s => s.replace(/[^\r\n]/g, " "));
  const edits: { start: number; end: number; text: string }[] = [], changed: string[] = [];
  for (const key of SIGNAL_NAMES) {
    const name = key.toUpperCase(), matches = [...masked.matchAll(new RegExp(`\\b(?:const\\s+)?(?:int|float|long|uint8_t|int32_t)\\s+${name}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)\\s*;`, "g"))];
    if(key==="vibration" && matches.length===0){edits.push({start:0,end:0,text:`const int VIBRATION = ${w.vibration??-1}; // optional SW-420 DO\n`});continue;}
    if (matches.length !== 1) throw new Error(`Automatic wiring needs exactly one numeric ${name} declaration. Add 'const int ${name} = ${w[key]??-1};' or use a preset before reconnecting.`);
    const m = matches[0], start = m.index! + m[0].indexOf("=") + 1, end = m.index! + m[0].lastIndexOf(";");
    edits.push({ start, end, text: ` ${w[key]??-1}` }); if (Number(m[1]) !== (w[key]??-1)) changed.push(name);
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return { source, changed };
}
