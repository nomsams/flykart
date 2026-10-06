import { expect,it } from 'vitest';
import { validateArena } from './world/arena';
import { WorldSession } from './ui/sessions';
import { SpikingNetwork,TRACKS } from '../core';
import { validateTrainingMaps,curriculumKey } from '../map-curriculum';
import { validateTrackSetup } from './format';
import { validateRecipe } from '../training-recipe';
import { DEFAULT_REWARD_CONFIG } from '../core';
const scene={format:'flykart-world',version:1,world:{seed:7,half:460,obstacles:[],patches:[]},start:{x:30,y:10,heading:0},goals:[{x:250,y:100},{x:-180,y:25}],exercise:{task:'forage',searchWin:'reach',goalPreset:'pair'}};
it('restores exact target positions and pose, without regenerating reverse goals',()=>{
 const a=validateArena(scene);
 for(const task of ['forage','reverse'] as const){const s=new WorldSession({seed:7,density:0,style:0,kind:'expert',fade:0,controller:new SpikingNetwork(1).toJSON(),vision:null,world:a.world,start:a.start,goals:a.goals,task,sensorOnly:true});expect(s.initialPose).toEqual(a.start);expect(s.episode.sim.goals).toEqual(expect.arrayContaining(a.goals!));expect(s.episode.sim.goalLimit).toBe(2);}
 expect(validateArena(JSON.parse(JSON.stringify(a)))).toEqual(a);
});
it('rejects malformed, blocked and out-of-bounds targets before installing a scene',()=>{
 for(const goals of [[],[{x:NaN,y:0}],[{x:460,y:0}],Array(31).fill({x:10,y:10})])expect(()=>validateArena({...scene,goals})).toThrow(/target points/);
 expect(()=>validateArena({...scene,world:{...scene.world,obstacles:[{kind:'rock',x:250,y:100,radius:30,height:40,tone:.5}]}})).toThrow(/target points/);
 expect(()=>validateArena({...scene,exercise:{...scene.exercise,task:'oracle'}})).toThrow(/exercise/);
});
it('keeps old scenes compatible and returns independent geometry',()=>{
 const old={...scene,goals:undefined,exercise:undefined};const a=validateArena(old);a.world.half=200;expect(old.world.half).toBe(460);expect(a.goals).toBeUndefined();
});
it('saves physically valid contact poses without requiring an extra invisible margin',()=>{
 expect(validateArena({...scene,start:{x:452,y:0,heading:0}}).start.x).toBe(452);
 const room={...scene.world,obstacles:[{kind:'rock',x:40,y:0,radius:20,height:40,tone:.5}]};
 expect(validateArena({...scene,world:room,start:{x:11.5,y:0,heading:0}}).start.x).toBe(11.5);
 expect(()=>validateArena({...scene,world:room,start:{x:13,y:0,heading:0}})).toThrow(/Start pose/);
});
it('canonicalizes map sets, rejects empty/unknown sets, and isolates subset score contexts',()=>{
 expect(validateTrainingMaps(['hairpin','grand-loop'])).toEqual(['grand-loop','hairpin']);
 expect(curriculumKey(TRACKS.map(t=>t.id))).toBe('all');expect(curriculumKey(['hairpin'])).not.toBe(curriculumKey(['grand-loop']));
 for(const ids of [[],['missing'],['hairpin','hairpin']])expect(()=>validateTrainingMaps(ids)).toThrow();
 const t={version:1,trackId:'grand-loop',rivals:0,style:0,memoryCount:4096,memoryEnabled:false,trainingMaps:['hairpin'],generalist:true};expect(validateTrackSetup(t)).toEqual(t);expect(()=>validateTrackSetup({...t,trainingMaps:[]})).toThrow();
 const recipe={version:1,domain:'race',reward:DEFAULT_REWARD_CONFIG,physics:{wallsEnabled:true,lapTarget:1,impactPain:false,checkpointCount:8,domainRandomization:0},obstacles:{enabled:false,count:0,kind:'mixed'},trainingMaps:['hairpin','grand-loop']};expect(validateRecipe(recipe).trainingMaps).toEqual(['grand-loop','hairpin']);expect(()=>validateRecipe({...recipe,trainingMaps:[]})).toThrow();
});
