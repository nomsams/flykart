import { Wiring, wiringIssues } from "./model";

export const SIGNAL_NAMES = ["in1", "in2", "in3", "in4", "ena", "enb", "trig", "echo"] as const;
export type SignalName = typeof SIGNAL_NAMES[number];
export const availablePins = (board: Wiring["board"]) => board === "esp32-cam" ? [1, 2, 3, 4, 12, 13, 14, 15] : Array.from({ length: 20 }, (_, i) => i);

/** Move the occupied signal back to the dragged wire's old pin, preserving uniqueness. */
export function reconnect(w: Wiring, signal: SignalName, pin: number): Wiring {
  if (!availablePins(w.board).includes(pin) && !(pin === -1 && ["ena", "enb"].includes(signal))) throw new Error("Choose an available GPIO or an enable jumper.");
  const next = { ...w }, old = w[signal];
  const occupied = SIGNAL_NAMES.find(k => k !== signal && next[k] === pin && pin >= 0);
  if (occupied) {
    if (old < 0 && !["ena", "enb"].includes(occupied)) throw new Error(`${occupied.toUpperCase()} needs a GPIO. Choose an unused pin first.`);
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
    if (matches.length !== 1) throw new Error(`Automatic wiring needs exactly one numeric ${name} declaration. Add 'const int ${name} = ${w[key]};' or use a preset before reconnecting.`);
    const m = matches[0], start = m.index! + m[0].indexOf("=") + 1, end = m.index! + m[0].lastIndexOf(";");
    edits.push({ start, end, text: ` ${w[key]}` }); if (Number(m[1]) !== w[key]) changed.push(name);
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return { source, changed };
}
