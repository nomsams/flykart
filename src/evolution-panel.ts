import {EvolutionStage,GenerationCheckpoint,describeEvolution,evolutionBase,evolutionRecords,generationFile,loadEvolution,saveEvolution,validatedGeneration} from './evolution-checkpoint';
import './evolution.css';
export class EvolutionPanel{
 readonly element=document.createElement('section');
 private saved:string|null=null;private persisted=false;private choice='active';private locked=false;private storageNote='';private lastActive:unknown=null;private currentText='';
 private runId='';private base='';private previous='';private baseGeneration=0;
 constructor(readonly stage:EvolutionStage,private active:()=>string,private identity:()=>unknown,private start:()=>void,private cancel:()=>void){
  this.element.className='evolution-parent';this.element.id=stage+'-evolution-parent';
  this.element.innerHTML=`<div class="evolution-row"><strong>Ghost evolution · ${stage==='track'?'Visual racer':stage==='world'?'Open world':'Parking'}</strong><label>Next parent <select id="${stage}-evolution-source"><option value="active">Active loaded brain</option><option value="saved" disabled>Autosaved evolution winner</option></select></label><button id="${stage}-evolve-top" class="primary" type="button">Evolve ghosts</button><button id="${stage}-evolve-stop-top" type="button" disabled>Cancel</button><button id="${stage}-evolution-export" type="button" disabled>Export saved winner</button><details><summary>Driving brain & training history</summary><small class="evolution-live"></small><p>Every completed generation saves its selected controller weights, eyes, setup and training metadata in this browser/site. Trial-specific memories and neural spike state are not saved. Evolve again uses that saved controller with the current eyes and exercise settings. Live driving changes through Use offspring. Cancelling an incomplete generation preserves the last completed checkpoint. Manual browser saves are separate.</p><pre class="evolution-history"></pre></details></div><p id="${stage}-evolution-status" role="status"></p>`;
  this.element.addEventListener('change',e=>e.stopPropagation());
  const select=this.select;select.onchange=()=>{if(this.locked){select.value=this.choice;return;}this.choice=select.value;this.refresh(true);};
  this.button('evolve-top').onclick=()=>{if(!this.locked)this.start();};this.button('evolve-stop-top').onclick=()=>{if(this.locked)this.cancel();};this.button('evolution-export').onclick=()=>{if(!this.saved)return;const url=URL.createObjectURL(new Blob([this.saved],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`flykart-${stage}-evolution-winner.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);};
 }
 private get select(){return this.element.querySelector<HTMLSelectElement>('select')!;}
 private button(name:string){return this.element.querySelector<HTMLButtonElement>('#'+this.stage+'-'+name)!;}
 async restore(){const saved=await loadEvolution(this.stage);if(saved){this.saved=saved.text;this.persisted=true;this.choice='saved';this.storageNote='Restored autosaved winner from this browser.';}this.refresh(true);}
 useActive(){this.choice='active';this.refresh(true);}
 refresh(force=false){const identity=this.identity();if(!force&&identity===this.lastActive&&this.currentText)return;if(force||identity!==this.lastActive){this.lastActive=identity;this.currentText=this.active();}if(!this.currentText)return;
  const active=describeEvolution(this.currentText),selected=describeEvolution(this.choice==='saved'&&this.saved?this.saved:this.currentText),records=evolutionRecords(this.choice==='saved'&&this.saved?this.saved:this.currentText);
  const savedOption=this.select.querySelector<HTMLOptionElement>('option[value=saved]')!;savedOption.disabled=!this.saved;savedOption.textContent=this.saved&&!this.persisted?'Latest winner · this tab only':'Autosaved evolution winner';this.select.value=this.choice;this.select.disabled=this.locked;
  this.button('evolve-top').disabled=this.locked;this.button('evolve-stop-top').disabled=!this.locked;this.button('evolution-export').disabled=!this.saved;
  this.element.querySelector('[role=status]')!.textContent=`${this.locked?'Current generation parent':'Next evolution parent'}: ${selected.name} · ${selected.id} · generation ${selected.generation} · ${this.choice==='saved'?(this.persisted?'autosaved winner':'winner retained in this tab'):'active loaded brain'}. ${this.storageNote}`;
  this.element.querySelector('.evolution-live')!.textContent=`Live driving: ${active.name} · ${active.id}. Eyes and sensor/exercise settings: current controls; changes are recorded in the next generation.`;
  this.element.querySelector('pre')!.textContent=records.length?records.slice(-40).reverse().map(r=>`Generation ${r.generation} · ${r.stage} · ${r.at}
  ghost ${r.winnerGhost} · score ${r.score.toFixed(2)} · ${r.parentBrainId} → ${r.brainId}
  ${JSON.stringify(r.training)}
  validation: ${JSON.stringify(r.validation)}`).join('\n\n'):'No recorded evolution yet. Imported weights may have earlier history not documented by this trainer.';
 }
 begin(){this.refresh(true);const selected=this.choice==='saved'&&this.saved?this.saved:this.currentText;this.base=evolutionBase(this.currentText,selected);this.previous=this.base;this.baseGeneration=describeEvolution(this.base).generation;this.runId=crypto.randomUUID();this.locked=true;this.storageNote='Saving after each completed generation.';this.refresh(true);return describeEvolution(this.base);}
 async checkpoint(c:GenerationCheckpoint){this.saved=generationFile(this.base,this.previous,this.stage,this.runId,c,this.baseGeneration);this.persisted=false;this.previous=this.saved;this.choice='saved';await this.persist();this.refresh(true);}
 async finish(validation?:unknown){if(validation!==undefined&&this.saved&&evolutionRecords(this.saved).some(r=>r.runId===this.runId)){this.saved=validatedGeneration(this.saved,this.runId,validation);await this.persist();}if(this.locked&&this.storageNote==='Saving after each completed generation.')this.storageNote='No new generation completed; the selected parent is retained.';this.locked=false;this.refresh(true);}
 private async persist(){try{await saveEvolution(this.stage,this.saved!);this.persisted=true;this.storageNote='Autosaved in this browser · ready for the next evolution run.';}catch(e){this.persisted=false;this.storageNote=(e as Error).message;}}
 get checkpointText(){return this.saved;}
}
