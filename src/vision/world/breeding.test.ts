import {expect,it} from 'vitest';
import {SpikingNetwork} from '../../core';
import {DEFAULT_WORLD_BREEDING,RecoveryLedger,worldPopulation,worldScout,worldBreedingContext,validateWorldBreeding,type WorldPopulation,type WorldGeneration} from './breeding';
import {parkingDonor} from '../../parking/gene-pool';
import {SearchJudge,DEFAULT_SEARCH_JUDGE} from './search-judge';
import {controllerCheckpoint,exportVisionBrain} from '../format';
import {savedRecovery,parseWorldTree,worldTreeText,nodeBrainText,type WorldHistoryNode} from './history';
import {trainWorldController} from './training';
import {WorldSession,type WorldSettings} from '../ui/sessions';
import {VisionCnn} from '../cnn';
import {defaultSpec,serialiseModel} from '../perception';
import {WORLD_CAMERA} from './worldDomain';

it('penalizes clockwise and counterclockwise reverse circles before they can bank exploration credit',()=>{
  for(const sign of [-1,1])for(const reverse of [false,true]){
    const j=new SearchJudge({...DEFAULT_SEARCH_JUDGE});j.reset(80,0);
    for(let t=1;t<=900;t++){const a=sign*t*Math.PI*2/300;j.observe(80*Math.cos(a),80*Math.sin(a),t,0,0,false,0,{visualSearch:true,reverse,targetVisible:false});}
    expect(j.penalty).toBeGreaterThan(8);expect(j.coverageReward).toBe(0);expect(j.reason).toMatch(/orbit|reverse|progress/);
  }
});
it('allows brief blind backing but does not reward unlimited reverse exploration; reverse exercises remain valid',()=>{
  const j=new SearchJudge({...DEFAULT_SEARCH_JUDGE});j.reset(0,0);
  for(let t=1;t<=90;t++)j.observe(-t,0,t,0,0,false,0,{visualSearch:true,reverse:true,targetVisible:false});
  expect(j.penalty).toBe(0);expect(j.coverageReward).toBe(0);
  for(let t=91;t<=300;t++)j.observe(-t,0,t,0,0,false,0,{visualSearch:true,reverse:true,targetVisible:false});expect(j.penalty).toBeGreaterThan(0);
  const practice=new SearchJudge({...DEFAULT_SEARCH_JUDGE});practice.reset(0,0);for(let t=1;t<=300;t++)practice.observe(-t,0,t,t/300,0,false,0,{visualSearch:false,reverse:true,targetVisible:false});expect(practice.penalty).toBe(0);
});
it('crossbreeds donor neuron units while protecting the exact parent; recovery changes deterministic descendants and adds a scout',()=>{
  const parent=new SpikingNetwork(10,19),donor=parkingDonor(JSON.stringify(controllerCheckpoint(new SpikingNetwork(20,19).toJSON(),{domain:'world'})),'donor');
  const a=worldPopulation(parent,5,[donor],40,1,DEFAULT_WORLD_BREEDING),b=worldPopulation(parent,5,[donor],40,1,DEFAULT_WORLD_BREEDING);
  expect(a.brains[0].toJSON()).toEqual(parent.toJSON());expect(a.brains.map(n=>n.toJSON())).toEqual(b.brains.map(n=>n.toJSON()));expect(a.donorParents[1]).toBe(donor.id);
  const recovered=worldPopulation(parent,5,[donor],700,1,DEFAULT_WORLD_BREEDING,2);expect(recovered.brains[0].toJSON()).toEqual(parent.toJSON());expect(recovered.donorParents.at(-1)).toMatch(/^scout-/);expect(recovered.brains[1].toJSON()).not.toEqual(a.brains[1].toJSON());
  expect(worldPopulation(new SpikingNetwork(10,17),2,[donor],40,1,DEFAULT_WORLD_BREEDING).brains[1].inputCount).toBe(17);
});
it('unrelated scouts start with a forward-search prior and retain both steering directions',()=>{
  const turns:number[]=[];for(let seed=1;seed<=8;seed++){const n=worldScout(seed,19);let a=n.step(Array(19).fill(.5));for(let i=0;i<60;i++)a=n.step(Array(19).fill(.5));expect(a.reverse).toBe(0);expect(a.throttle).toBeGreaterThan(.1);turns.push(a.steer);}
  expect(turns.some(s=>s<0)).toBe(true);expect(turns.some(s=>s>0)).toBe(true);
});
it('rolls plateaus back to retained milestones, persists pending recovery across jobs and respects the off switch',()=>{
  const brain=new SpikingNetwork(10).toJSON(),cfg={...DEFAULT_WORLD_BREEDING,plateauAfter:2};const root={id:'root',brain},best={id:'best',brain:new SpikingNetwork(20).toJSON()};
  const l=new RecoveryLedger(cfg,root);expect(l.complete(1,best,10,0,'best')).toBe(true);l.complete(2,{id:'flat2',brain},9,0,'flat2');l.complete(3,{id:'flat3',brain},9,0,'flat3');
  expect(l.snapshot().pending?.to).toBe('best');const resumed=new RecoveryLedger(cfg,{id:'newRoot',brain},[root,best],l.snapshot()),r=resumed.take()!;expect(r.ancestor.id).toBe('best');expect(r.recovery.from).toBe('flat3');expect(r.recovery.mutationScale).toBe(2);
  expect(resumed.take()).toBeNull();const off=new RecoveryLedger({...cfg,autoRecover:false},root);for(let g=1;g<=6;g++)off.complete(g,null,-1000000,0,'root');expect(off.take()).toBeNull();expect(()=>validateWorldBreeding({...cfg,plateauAfter:1})).toThrow();
});
it('the real evolver admits live donors next generation, records rollback parents and changes scouts without touching the driving parent',async()=>{
  const spec={...defaultSpec(2,10,'rgb',false),channels:[1,1,1] as [number,number,number],hidden:4},controller=new SpikingNetwork(3,19).toJSON();
  const settings:WorldSettings={seed:7,density:0,style:0,kind:'vision',fade:0,task:'explore',world:{seed:1,half:460,obstacles:[],patches:[]},start:{x:0,y:0,heading:0},controller,vision:serialiseModel(new VisionCnn(spec,7),WORLD_CAMERA,Array(10).fill(1),'test',undefined,undefined,'world'),maxTicks:12};
  const donor=(seed:number)=>parkingDonor(JSON.stringify(controllerCheckpoint(new SpikingNetwork(seed,19).toJSON(),{domain:'world'})),'donor');const a=donor(9),b=donor(10);let pool=[a];
  const born:WorldPopulation[]=[],metrics:WorldGeneration[]=[];
  const stop=(sessions:WorldSession[])=>{for(const s of sessions){const d=s.driver!;d.act=()=>({action:{steer:0,throttle:0,brake:1,reverse:0}} as ReturnType<typeof d.act>);}};
  const report=await trainWorldController(settings,5,3,.2,()=>false,()=>{},stop,0,false,true,undefined,{runId:'test',seed:123,breeding:{...DEFAULT_WORLD_BREEDING,plateauAfter:2},getGenePool:()=>pool,onPopulation:p=>born.push(p),onMetrics:m=>{metrics.push(m);if(m.generation===1)pool=[a,b];}});
  expect(born.find(p=>p.generation===1)!.donorParents[1]).toBe(a.id);expect(born.find(p=>p.generation===2)!.donorParents[1]).toBe(b.id);
  const branch=born.find(p=>p.recovery)!;expect(branch.generation).toBe(4);expect(branch.parent).toBe('test:1');expect(branch.donorParents.at(-1)).toMatch(/^scout-/);expect(metrics).toHaveLength(5);expect(settings.controller).toEqual(controller);expect(report!.brain).toEqual(controller);
},30000);
it('round trips complete ancestry and exact generation weights, preserves parent generation and rejects missing parents',()=>{
  const brain=new SpikingNetwork(10).toJSON(),child=new SpikingNetwork(20).toJSON(),base=exportVisionBrain({name:'Tree fixture',controller:controllerCheckpoint(brain,{domain:'world',generation:50}),vision:null,fusion:{fade:0,mode:'belief',visionTemperature:1},memory:null,world:null});
  // Use the actual exporter format/version accepted by the application.
  const root:WorldHistoryNode={id:'root',run:'r',parent:null,donors:[],generation:0,at:new Date().toISOString(),score:0,milestone:true,brain,base};
  const node:WorldHistoryNode={...root,id:'child',parent:'root',generation:2,brain:child,score:12,base:undefined};
  const tree=parseWorldTree(worldTreeText([root,node]));const text=JSON.parse(nodeBrainText(tree[1],tree));expect(text.controller.network).toEqual(child);expect(text.controller.generation).toBe(52);
  expect(()=>parseWorldTree(worldTreeText([node]))).toThrow(/Missing tree parent/);expect(()=>parseWorldTree(worldTreeText([root,root]))).toThrow(/Duplicate/);expect(()=>parseWorldTree(worldTreeText([{...root,parent:'child'},node]))).toThrow(/Cyclic/);
});
it('resumes rejected plateau events against the retained controller, including a rolled-back breeding parent',()=>{
  const brain=new SpikingNetwork(1).toJSON(),older=new SpikingNetwork(2).toJSON(),cfg={...DEFAULT_WORLD_BREEDING};
  const root:WorldHistoryNode={id:'r:root',run:'r',parent:null,donors:[],generation:0,at:'2026-10-12',score:0,milestone:true,brain};
  const old={...root,id:'old:root',run:'old',brain:older};
  const state={best:10,wins:0,stale:2,branch:1,pending:{generation:4,from:'r:root',to:'old:root',branch:1,mutationScale:2,stale:2}};
  const metrics:WorldGeneration={generation:3,node:'r:3',parent:'old:root',brain:null,winner:-1,scores:[-1,-1],trials:[[],[]],donorParents:[null,null],plateau:2,milestone:false,recovery:null,state,context:'same'};
  const events=[{id:'r:3',at:'2026-10-12',metrics}];
  expect(savedRecovery([old,root],events,brain,'same')).toEqual(state);expect(savedRecovery([old,root],events,older,'same')).toBeUndefined();expect(savedRecovery([old,root],events,brain,'different')).toBeUndefined();
  const settings:WorldSettings={seed:1,density:0,style:0,kind:'vision',fade:0,controller:brain,vision:null};
  const base=worldBreedingContext(settings,cfg,{crashWeight:.2,coach:false,retain:true});
  expect(worldBreedingContext({...settings,goalRadius:20},cfg,{crashWeight:.2,coach:false,retain:true})).not.toBe(base);
  expect(worldBreedingContext({...settings,cameraNoise:.1},cfg,{crashWeight:.2,coach:false,retain:true})).not.toBe(base);
  expect(worldBreedingContext(settings,cfg,{crashWeight:.8,coach:false,retain:true})).not.toBe(base);
});
