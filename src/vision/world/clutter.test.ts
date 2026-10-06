import { expect,it } from 'vitest';
import { WorldSim, WorldDef, Obstacle, castRay } from './world';
import { generateClutter, solids, contact } from './objects';
import { validateArena, clearPoint } from './arena';
import { WorldEpisode } from './worldDomain';
import { HC_SR04 } from '../robot';
import { goalScore } from './training';
import { RoomMemory } from '../../robot/memory';
import { validateVisionSettings, viewPatches, cropView } from '../../robot/vision-workbench';
const item=(kind:Obstacle['kind'],extra:Partial<Obstacle>={}):Obstacle=>({kind,x:50,y:0,radius:30,height:40,tone:.5,...extra});
const field=(obstacles:Obstacle[]):WorldDef=>({seed:1,half:460,patches:[],obstacles});
const start={x:0,y:0,heading:0},goals=[{x:160,y:0}];
const gas={steer:0,throttle:1,brake:0};
it('generates reproducible valid clutter with a clear start and increasing density',()=>{
 for(const style of ['room','workshop','bedroom'] as const){const world=generateClutter(17,.8,style);expect(world).toEqual(generateClutter(17,.8,style));expect(validateArena({format:'flykart-world',version:1,world,start}).world).toEqual(world);expect(world.obstacles.length).toBeGreaterThan(generateClutter(17,.1,style).obstacles.length);expect(clearPoint(world,0,0)).toBe(true);}
});
it('passes through high furniture centres, hits legs, and blocks beneath a low top',()=>{
 const table=item('table');const world=field([table]);expect(clearPoint(world,50,0)).toBe(true);expect(solids(table)).toHaveLength(4);expect(castRay(world,0,0,0,200)).toBe(200);
 const sim=new WorldSim(7,{world,start,goals,goalLimit:1});while(!sim.done)sim.step(gas);expect(sim.status.goals).toBe(1);expect(sim.status.collisions).toBe(0);
 const low={...table,clearance:4};expect(clearPoint(field([low]),50,0)).toBe(false);expect(castRay(field([low]),0,0,0,200)).toBeCloseTo(12);
 expect(contact(solids(table)[0],17,-16.5,8)).not.toBeNull();
 // Rounded rectangle corners: being inside the bounding cell is not contact.
 const box=solids(low)[0];expect(contact(box,88,27.5,8)).toBeNull();
});
it('pushes shoes, reduces pain relative to fixed obstacles, and isolates candidate worlds',()=>{
 const shoe=item('shoe',{radius:10,height:7,x:30});const world=field([shoe]);
 const run=(kind:Obstacle['kind'])=>{const sim=new WorldSim(1,{world:field([{...shoe,kind}]),start,goals,goalLimit:1});sim.kart.speed=60;for(let i=0;i<12;i++)sim.step(gas);return sim;};
 const soft=run('shoe'),hard=run('rock');expect(soft.world.obstacles[0].x).toBeGreaterThan(shoe.x);expect(soft.status.pain).toBeLessThan(hard.status.pain);expect(soft.status.collisions).toBeGreaterThan(0);
 const a=new WorldSim(1,{world,start,goals}),b=new WorldSim(1,{world,start,goals});a.world.obstacles[0].x=90;expect(b.world.obstacles[0].x).toBe(30);expect(world.obstacles[0].x).toBe(30);
});
it('updates raw camera geometry and sonar after a light object moves',()=>{
 const ep=new WorldEpisode({seed:1,world:field([item('shoe',{x:60,radius:12,height:15})]),start,goals,sonar:{...HC_SR04,noiseBaseCm:0,noiseProportional:0,soundScaleSigma:0,speckleSigma:0,ghostProbability:0}});
 expect(ep.sonar()!.echo).toBe(true);const oldRange=ep.sonar()!.range;
 ep.render();const old=ep.scene!.sprites.find(s=>s.shape==='rock')!.x;ep.sim.world.obstacles[0].x=110;ep.render();expect(ep.scene!.sprites.find(s=>s.shape==='rock')!.x).toBe(110);expect(old).toBe(60);
 // The target list is rebuilt, rather than caching the original shoe position.
 ep.refreshSonar();expect(ep.sonar()!.echo).toBe(true);expect(ep.sonar()!.range).toBeGreaterThan(oldRange+40);
});
it('crosses floor clutter without collision labels or pain, with slower traction',()=>{
 const clean=new WorldSim(1,{world:field([]),start,goals}),clutter=new WorldSim(1,{world:field([item('mat',{x:0,radius:100,height:.5}),item('cable',{x:15,radius:20,height:1})]),start,goals});
 for(let i=0;i<30;i++){clean.step(gas);clutter.step(gas);}expect(clutter.status.pain).toBe(0);expect(clutter.status.collisions).toBe(0);expect(clutter.kart.x).toBeLessThan(clean.kart.x);
});
it('uses impact pain in selection while retaining legacy report scoring',()=>{
 const trial={arrived:true,ticks:500,collisions:1,progress:1,reverseDistance:0,crashed:false};expect(goalScore({...trial,pain:.1},900,.2)).toBeGreaterThan(goalScore({...trial,pain:1},900,.2));expect(goalScore(trial,900,.2)).toBe(goalScore({...trial,pain:1},900,.2));
});
it('charges less pain for a glancing impact than a head-on impact at equal speed',()=>{
 const world=field([item('rock',{x:0,radius:20})]);
 const bump=(x:number,y:number)=>{const sim=new WorldSim(1,{world,start:{x,y,heading:0},goals});sim.kart.speed=60;sim.step(gas);return sim.status;};
 const head=bump(-28,0),glance=bump(-5,27);expect(head.collisions).toBe(1);expect(glance.collisions).toBe(1);expect(glance.pain).toBeLessThan(head.pain*.25);
});
it('supports 40000 independent cells and nine distinct virtual views with portable settings',()=>{
 const m=new RoomMemory({count:40000,sparsity:.01,rareWeighting:true});expect(m.count).toBe(40000);const settings=validateVisionSettings({normalize:false,smooth:false,temporal:1,layout:'circle9',radius:.15});expect(viewPatches(settings)).toHaveLength(9);
 const image=Float32Array.from({length:48*24*3},(_,i)=>i/3456);const views=viewPatches(settings).map(p=>Array.from(cropView(image,48,24,p)));expect(new Set(views.map(v=>JSON.stringify(v))).size).toBe(9);expect(validateVisionSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
});
