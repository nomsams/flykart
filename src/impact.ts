/** A teaching cost, not a force model or a controller input. Closing speed is
 * measured along the contact normal before the collision impulse. */
export function impactSeverity(closingSpeed: number): number {
  if (!Number.isFinite(closingSpeed)) return 0.2;
  return Math.min(6, 0.2 + 3 * (Math.max(0, closingSpeed) / 90) ** 2);
}
