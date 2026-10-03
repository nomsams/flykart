export type EventKind = "system" | "sonar" | "camera" | "brain" | "serial" | "check";
export type TelemetryEvent = { time: number; kind: EventKind; message: string; data?: unknown };
export class SensorConsole {
  readonly events: TelemetryEvent[] = [];
  revision = 0;
  constructor(readonly capacity = 1500) {}
  push(time: number, kind: EventKind, message: string, data?: unknown): void {
    this.events.push({ time: Math.round(time * 1000) / 1000, kind, message, ...(data !== undefined ? { data } : {}) });
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    this.revision++;
  }
  clear(): void { this.events.length = 0; this.revision++; }
  select(kind: string): TelemetryEvent[] { return kind === "all" ? this.events : this.events.filter(e => e.kind === kind); }
}
