import { clamp } from "../core";
import { Wiring } from "./model";

type Expr = { kind: "number"; value: number } | { kind: "text"; value: string } | { kind: "name"; name: string } | { kind: "call"; name: string; args: Expr[] } | { kind: "unary"; op: string; expr: Expr } | { kind: "binary"; op: string; left: Expr; right: Expr };
type Statement = ({ kind: "block"; body: Statement[] } | { kind: "if"; condition: Expr; yes: Statement; no?: Statement } | { kind: "declare"; name: string; expr: Expr; constant: boolean } | { kind: "assign"; name: string; expr: Expr } | { kind: "expr"; expr: Expr } | { kind: "return"; expr: Expr }) & { line?: number };
type FunctionDef = { args: string[]; body: Statement };
type Token = { value: string; line: number };
const TYPES = ["void", "int", "float", "double", "long", "bool", "unsigned", "uint8_t", "uint32_t"];
const PRECEDENCE: Record<string, number> = { "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, ">": 4, "<=": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6 };
function tokenize(code: string): Token[] {
  if (code.length > 60000) throw new Error("Sketch is too large (60 KB maximum).");
  // Preserve quoted strings while stripping comments, including URLs in print text.
  code = code.replace(/"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, s => s.startsWith('"') ? s : s.replace(/[^\n]/g, " "));
  code = code.replace(/^\s*#define\s+(\w+)\s+([^\n]+)$/gm, "const float $1 = $2;");
  const tokens: Token[] = []; let line = 1;
  const regex = /\s+|"(?:[^"\\]|\\.)*"|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+|Serial\.(?:begin|println|print)|[A-Za-z_]\w*|==|!=|<=|>=|&&|\|\||[{}();,+*/%!=<>-]/gy;
  let offset = 0;
  while (offset < code.length) {
    regex.lastIndex = offset; const m = regex.exec(code);
    if (!m) throw new Error(`Line ${line}: unsupported character '${code[offset]}'. Libraries and pointers are outside the simulator subset.`);
    if (!/^\s/.test(m[0])) tokens.push({ value: m[0], line });
    line += (m[0].match(/\n/g) ?? []).length; offset = regex.lastIndex;
  }
  return tokens;
}

class Parser {
  private index = 0;
  readonly functions = new Map<string, FunctionDef>();
  readonly globals: Statement[] = [];
  constructor(private tokens: Token[]) {
    while (this.index < tokens.length) {
      const constant = this.take("const"); this.type(); const name = this.identifier();
      if (this.take("(")) {
        if (constant) this.fail("a function cannot be const");
        const args: string[] = [];
        if (!this.take(")")) { do { this.type(); args.push(this.identifier()); } while (this.take(",")); this.expect(")"); }
        if (this.functions.has(name)) this.fail(`duplicate function ${name}`);
        this.functions.set(name, { args, body: this.statement() });
      } else { const expr = this.take("=") ? this.expression() : { kind: "number" as const, value: 0 }; this.expect(";"); this.globals.push({ kind: "declare", name, expr, constant }); }
    }
    if (!this.functions.has("setup") || !this.functions.has("loop")) this.fail("provide void setup() and void loop()");
  }
  private fail(message: string): never { throw new Error(`Line ${this.tokens[this.index]?.line ?? this.tokens.at(-1)?.line ?? 1}: ${message}`); }
  private peek(): string { return this.tokens[this.index]?.value ?? ""; }
  private take(value: string): boolean { if (this.peek() !== value) return false; this.index++; return true; }
  private expect(value: string): void { if (!this.take(value)) this.fail(`expected '${value}', found '${this.peek() || "end of file"}'`); }
  private identifier(): string { const value = this.peek(); if (!/^[A-Za-z_]\w*(?:\.(?:begin|println|print))?$/.test(value)) this.fail("expected an identifier"); this.index++; return value; }
  private type(): void { if (!TYPES.includes(this.peek())) this.fail(`unsupported type or statement '${this.peek()}'`); this.index++; if (this.tokens[this.index - 1].value === "unsigned" && TYPES.includes(this.peek())) this.index++; }
  private statement(): Statement {
    const line = this.tokens[this.index]?.line;
    return { ...this.parseStatement(), line };
  }
  private parseStatement(): Statement {
    if (this.take("{")) { const body: Statement[] = []; while (!this.take("}")) { if (!this.peek()) this.fail("unclosed block"); body.push(this.statement()); } return { kind: "block", body }; }
    if (this.take("if")) { this.expect("("); const condition = this.expression(); this.expect(")"); const yes = this.statement(), no = this.take("else") ? this.statement() : undefined; return { kind: "if", condition, yes, no }; }
    if (this.take("return")) { const expr = this.peek() === ";" ? { kind: "number" as const, value: 0 } : this.expression(); this.expect(";"); return { kind: "return", expr }; }
    if (["for", "while", "do", "switch"].includes(this.peek())) this.fail("loops and switch are unsupported; loop() is scheduled automatically");
    const constant = this.take("const");
    if (constant || TYPES.includes(this.peek())) { this.type(); const name = this.identifier(), expr = this.take("=") ? this.expression() : { kind: "number" as const, value: 0 }; this.expect(";"); return { kind: "declare", name, expr, constant }; }
    if (this.tokens[this.index + 1]?.value === "=") { const name = this.identifier(); this.expect("="); const expr = this.expression(); this.expect(";"); return { kind: "assign", name, expr }; }
    const expr = this.expression(); this.expect(";"); return { kind: "expr", expr };
  }
  private expression(min = 0): Expr {
    let left: Expr;
    if (["-", "+", "!"].includes(this.peek())) { const op = this.peek(); this.index++; left = { kind: "unary", op, expr: this.expression(7) }; }
    else if (this.take("(")) { left = this.expression(); this.expect(")"); }
    else if (this.peek().startsWith('"')) { left = { kind: "text", value: JSON.parse(this.peek()) as string }; this.index++; }
    else if (/^(?:\d|\.)/.test(this.peek())) { left = { kind: "number", value: Number(this.peek()) }; this.index++; }
    else {
      const name = this.identifier();
      if (this.take("(")) { const args: Expr[] = []; if (!this.take(")")) { do { args.push(this.expression()); } while (this.take(",")); this.expect(")"); } left = { kind: "call", name, args }; }
      else left = { kind: "name", name };
    }
    while (PRECEDENCE[this.peek()] !== undefined && PRECEDENCE[this.peek()] >= min) { const op = this.peek(); this.index++; left = { kind: "binary", op, left, right: this.expression(PRECEDENCE[op] + 1) }; }
    return left;
  }
}
type Scope = { values: Map<string, number>; constants: Set<string>; parent?: Scope };
export type FirmwareHost = { timeMs: number; brainLeft: number; brainRight: number; echoUs: number; wiring: Wiring; camera?: { frame: number; rgb: number[] }; log?: (line: string) => void; phase?: (index: number) => void; sonarRead?: (pulse: number) => void };
export class Firmware {
  readonly pins = new Map<number, number>();
  readonly modes = new Map<number, number>();
  currentLine = 1;
  private parser: Parser;
  private globals: Scope = { values: new Map([["HIGH", 1], ["LOW", 0], ["OUTPUT", 1], ["INPUT", 0], ["true", 1], ["false", 0]]), constants: new Set(["HIGH", "LOW", "OUTPUT", "INPUT", "true", "false"]) };
  private execution: Generator<number, number> | null = null;
  private initialized = false; private wake = 0; private budget = 0;
  private trigHigh = false; private triggerWidth = 0; private triggered = false; private lastPing = -Infinity;
  private serialBuffer = "";
  private host: FirmwareHost = { timeMs: 0, brainLeft: 0, brainRight: 0, echoUs: 0, wiring: {} as Wiring };
  constructor(readonly source: string) { this.parser = new Parser(tokenize(source)); }
  private scopeFor(name: string, scope: Scope): Scope { if (scope.values.has(name)) return scope; if (scope.parent) return this.scopeFor(name, scope.parent); throw new Error(`Unknown variable '${name}'.`); }
  private *evaluate(e: Expr, scope: Scope, depth: number): Generator<number, number> {
    if (++this.budget > 6000 || depth > 16) throw new Error("Sketch execution limit exceeded (possible recursion).");
    if (e.kind === "number") return e.value;
    if (e.kind === "text") throw new Error("Strings are supported only as Serial.print/println arguments.");
    if (e.kind === "name") return this.scopeFor(e.name, scope).values.get(e.name)!;
    if (e.kind === "unary") { const v = yield* this.evaluate(e.expr, scope, depth); return e.op === "!" ? +!v : e.op === "-" ? -v : v; }
    if (e.kind === "binary") {
      const a = yield* this.evaluate(e.left, scope, depth);
      if (e.op === "&&" && !a) return 0; if (e.op === "||" && a) return 1;
      const b = yield* this.evaluate(e.right, scope, depth);
      switch (e.op) { case "+": return a + b; case "-": return a - b; case "*": return a * b; case "/": if (!b) throw new Error("Division by zero."); return a / b; case "%": return a % b; case "<": return +(a < b); case ">": return +(a > b); case "<=": return +(a <= b); case ">=": return +(a >= b); case "==": return +(a === b); case "!=": return +(a !== b); case "&&": return +!!b; case "||": return +!!b; }
      return 0;
    }
    if (e.name === "Serial.print" || e.name === "Serial.println") {
      const parts: string[] = [];
      for (const a of e.args) parts.push(a.kind === "text" ? a.value : String(Math.round((yield* this.evaluate(a, scope, depth)) * 1000) / 1000));
      this.serialBuffer = (this.serialBuffer + parts.join("")).slice(-2000);
      if (e.name === "Serial.println") { this.host.log?.(this.serialBuffer); this.serialBuffer = ""; }
      return 0;
    }
    const args: number[] = []; for (const a of e.args) args.push(yield* this.evaluate(a, scope, depth));
    const [a = 0, b = 0, c = 0] = args;
    const finite = (v: number) => { if (!Number.isFinite(v)) throw new Error("Sketch produced a non-finite number."); return v; };
    switch (e.name) {
      case "pinMode": this.modes.set(a, b); return 0;
      case "digitalWrite": case "analogWrite": {
        if (this.modes.get(a) !== 1) throw new Error(`GPIO${a}: call pinMode(pin, OUTPUT) before writing.`);
        this.pins.set(a, finite(clamp(e.name === "digitalWrite" ? b * 255 : b, 0, 255)));
        if (a === this.host.wiring.trig) { if (b > 0) { this.trigHigh = true; this.triggerWidth = 0; } else if (this.trigHigh) { this.triggered = this.triggerWidth >= 10; this.trigHigh = false; } }
        return 0;
      }
      case "digitalRead": return +((this.pins.get(a) ?? 0) > 0);
      case "brainLeft": return this.host.brainLeft;
      case "brainRight": return this.host.brainRight;
      case "Serial.begin": return 0;
      case "cameraFrame": return this.host.camera?.frame ?? 0;
      case "cameraMeanR": return this.host.camera?.rgb[0] ?? 0;
      case "cameraMeanG": return this.host.camera?.rgb[1] ?? 0;
      case "cameraMeanB": return this.host.camera?.rgb[2] ?? 0;
      case "phase": this.host.phase?.(a); return 0;
      case "millis": return this.host.timeMs;
      case "delay": if (a < 0 || a > 60000) throw new Error("delay must be 0–60000 ms."); yield a; return 0;
      case "delayMicroseconds": if (a < 0 || a > 10000) throw new Error("delayMicroseconds must be 0–10000 µs."); if (this.trigHigh) this.triggerWidth += a; return 0;
      case "pulseIn": {
        if (a !== this.host.wiring.echo || this.modes.get(a) !== 0 || !this.triggered || b !== 1) return 0;
        this.triggered = false;
        if (this.host.timeMs - this.lastPing < 60) return 0;
        this.lastPing = this.host.timeMs;
        const timeout = args[2] ?? 1000000;
        const echo = this.host.echoUs > 0 && this.host.echoUs <= timeout ? this.host.echoUs : 0;
        yield Math.min(echo || timeout, 1000000) / 1000;
        this.host.sonarRead?.(echo);
        return echo;
      }
      case "abs": return Math.abs(a); case "min": return Math.min(a, b); case "max": return Math.max(a, b); case "constrain": return clamp(a, b, c);
      default: {
        const fn = this.parser.functions.get(e.name); if (!fn) throw new Error(`Unsupported function '${e.name}'.`);
        if (fn.args.length !== args.length) throw new Error(`${e.name} expects ${fn.args.length} arguments.`);
        const result = yield* this.execute(fn.body, { values: new Map(fn.args.map((name, i) => [name, args[i]])), constants: new Set(), parent: this.globals }, depth + 1);
        return result ?? 0;
      }
    }
  }
  private *execute(s: Statement, scope: Scope, depth: number): Generator<number, number | undefined> {
    if (s.line) this.currentLine = s.line;
    if (++this.budget > 6000) throw new Error("Sketch execution limit exceeded.");
    if (s.kind === "block") { const local: Scope = { values: new Map(), constants: new Set(), parent: scope }; for (const child of s.body) { const result = yield* this.execute(child, local, depth); if (result !== undefined) return result; } return; }
    if (s.kind === "if") { const condition = yield* this.evaluate(s.condition, scope, depth); const branch = condition ? s.yes : s.no; if (branch) return yield* this.execute(branch, scope, depth); return; }
    const value = yield* this.evaluate(s.expr, scope, depth);
    if (!Number.isFinite(value)) throw new Error("Sketch produced a non-finite value.");
    if (s.kind === "return") return value;
    if (s.kind === "declare") { if (scope.values.has(s.name)) throw new Error(`Duplicate variable ${s.name}.`); scope.values.set(s.name, value); if (s.constant) scope.constants.add(s.name); }
    if (s.kind === "assign") { const target = this.scopeFor(s.name, scope); if (target.constants.has(s.name)) throw new Error(`Cannot assign constant ${s.name}.`); target.values.set(s.name, value); }
  }
  private *program(): Generator<number, number> {
    for (const s of this.parser.globals) yield* this.execute(s, this.globals, 0);
    yield* this.evaluate({ kind: "call", name: "setup", args: [] }, this.globals, 0);
    this.initialized = true;
    return 0;
  }
  tick(host: FirmwareHost): void {
    this.host = host; this.budget = 0;
    if (host.timeMs + .001 < this.wake) return;
    if (!this.execution) this.execution = this.initialized ? this.evaluate({ kind: "call", name: "loop", args: [] }, this.globals, 0) : this.program();
    const result = this.execution.next();
    if (!result.done) this.wake = host.timeMs + result.value;
    else { this.execution = null; if (this.initialized) this.wake = host.timeMs; }
  }
  motors(w: Wiring): [number, number] {
    const duty = (pin: number, jumper = false) => pin < 0 ? (jumper ? 1 : 0) : (this.pins.get(pin) ?? 0) / 255;
    return [(duty(w.in1) - duty(w.in2)) * duty(w.ena, true), (duty(w.in3) - duty(w.in4)) * duty(w.enb, true)];
  }
}

export function defaultSketch(w: Wiring, reflex = false): string {
  return `// Arduino-style simulation sketch. ESP32-CAM + L298N.
// brainLeft()/brainRight(): signed PWM requests from the fly (-255..255).
// These two functions need a real inference/communications adapter on hardware.
// ENA/ENB = -1: keep enable jumpers fitted; PWM the direction inputs.
const int IN1 = ${w.in1};
const int IN2 = ${w.in2};
const int IN3 = ${w.in3};
const int IN4 = ${w.in4};
const int ENA = ${w.ena};
const int ENB = ${w.enb};
const int TRIG = ${w.trig};
const int ECHO = ${w.echo};
const float STOP_CM = ${reflex ? 22 : 0}; // 0: the fly controls the robot freely

void setup() {
  pinMode(IN1, OUTPUT); pinMode(IN2, OUTPUT);
  pinMode(IN3, OUTPUT); pinMode(IN4, OUTPUT);
  pinMode(TRIG, OUTPUT); pinMode(ECHO, INPUT);
  if (ENA >= 0) { pinMode(ENA, OUTPUT); analogWrite(ENA, 255); }
  if (ENB >= 0) { pinMode(ENB, OUTPUT); analogWrite(ENB, 255); }
}

float readSonarCm() {
  digitalWrite(TRIG, LOW); delayMicroseconds(2);
  digitalWrite(TRIG, HIGH); delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  float duration = pulseIn(ECHO, HIGH, 25000);
  if (duration == 0) { return -1; } // timeout is unknown, never zero distance
  return duration / 58;
}

void motor(int a, int b, float pwm) {
  analogWrite(a, max(0, pwm));
  analogWrite(b, max(0, -pwm));
}

void loop() {
  float cm = readSonarCm();
  float left = brainLeft();
  float right = brainRight();
  if (STOP_CM > 0 && cm > 0 && cm < STOP_CM) {
    left = -100; right = 110;
  }
  motor(IN1, IN2, left);
  motor(IN3, IN4, right);
  delay(67);
}
`;
}
