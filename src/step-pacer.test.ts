import { describe, expect, it } from 'vitest';
import { StepPacer } from './step-pacer';
describe('fixed-step training pace', () => {
  it('changes wall-clock throughput without changing the number of ticks per simulated second', () => {
    const count=(speed:number)=>{const p=new StepPacer();p.reset(0);let ticks=0;for(let t=10;t<=1000;t+=10){const n=p.budget(t,speed);for(let i=0;i<n;i++){p.consume();ticks++;}}return ticks;};
    expect(count(1)).toBe(30);expect(count(8)).toBe(240);expect(count(16)).toBe(480);
  });
  it('retains unfinished work, bounds tab-resume catch-up and resets when changing modes', () => {
    const p=new StepPacer();p.reset(0);expect(p.budget(100,4)).toBe(12);p.consume();expect(p.budget(100,4)).toBe(11);
    expect(p.budget(100_000,16)).toBeLessThanOrEqual(512);expect(p.budget(100_001,0)).toBe(512);
    expect(p.budget(100_011,1)).toBe(0);p.reset(0);expect(p.budget(10,1)).toBe(0);
  });
});
