import {attachJsonImport} from '../json-import';
import {REPOSITORY_BRAINS} from '../repository-brains';
import {MAX_PARKING_DONORS,parkingDonor,validateParkingPool,parsePool,poolText,type ParkingDonor} from './gene-pool';

const STORE='flykart.parking-gene-pool.v1';
export class ParkingGenePool{
  readonly element=document.createElement('details');
  private pool:ParkingDonor[]=[];
  get donors(){return this.pool;}
  ready(){this.note(`${this.pool.length} donor(s) ready for the next evolution run. Completed winners and the active driving brain are kept separately.`);}
  constructor(private busy:()=>boolean,private log:(text:string)=>void){
    this.element.className='parking-gene-pool';
    this.element.innerHTML=`<summary>Gene pool · <span data-count>0 donors</span></summary><div class="row gene-pool-actions"><button id="pool-add">Add JSON brain…</button><input id="pool-file" type="file" hidden><select id="pool-repository" aria-label="Gene pool repository brain">${REPOSITORY_BRAINS.map(b=>`<option value="${b.id}">${b.label}</option>`).join('')}</select><button id="pool-repository-add">Add repository donor</button><label class="check"><input id="pool-adapt" type="checkbox">Adapt Racer v1 inputs</label><button id="pool-export">Export pool</button></div><small>Available during evolution. New donors enter the next generation; the current trial and exact winner stay unchanged. Half the descendants mix controller neuron units with donors; the others remain local mutations. All use the current eyes, sensors and fresh independent memory. Donors must win the same trials; mixing is not guaranteed to improve driving.</small><div data-donors></div><small data-status role="status"></small>`;
    try{const saved=localStorage.getItem(STORE);if(saved)this.pool=parsePool(saved);}catch{this.note('Saved pool could not be read. It was left untouched; import a valid pool or brain.');}
    const input=this.element.querySelector<HTMLInputElement>('#pool-file')!;
    attachJsonImport(input,(text,name)=>{
      const raw=JSON.parse(text),incoming=raw.format==='flykart-parking-gene-pool'?parsePool(text):[parkingDonor(text,name,this.element.querySelector<HTMLInputElement>('#pool-adapt')!.checked)];
      this.add(incoming);
    },{title:'Add gene-pool donors · file or pasted JSON',trigger:this.element.querySelector<HTMLElement>('#pool-add')!,onError:m=>this.note(m)});
    this.element.querySelector<HTMLButtonElement>('#pool-repository-add')!.onclick=async()=>{
      const button=this.element.querySelector<HTMLButtonElement>('#pool-repository-add')!;button.disabled=true;
      try{const selected=this.element.querySelector<HTMLSelectElement>('#pool-repository')!.value,source=REPOSITORY_BRAINS.find(b=>b.id===selected)!;this.add([parkingDonor(await source.load(),source.file,this.element.querySelector<HTMLInputElement>('#pool-adapt')!.checked)]);}catch(e){this.note((e as Error).message);}finally{button.disabled=false;}
    };
    this.element.querySelector<HTMLButtonElement>('#pool-export')!.onclick=()=>{const a=document.createElement('a'),url=URL.createObjectURL(new Blob([poolText(this.pool)],{type:'application/json'}));a.href=url;a.download='parking-gene-pool.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);};
    this.paint();
  }
  private note(text:string){this.element.querySelector<HTMLElement>('[data-status]')!.textContent=text;}
  private add(incoming:ParkingDonor[]){
    const next=[...this.pool];for(const donor of incoming)if(!next.some(d=>d.id===donor.id))next.push(donor);
    if(next.length===this.pool.length){this.note('That controller is already in the pool.');return;}
    if(next.length>MAX_PARKING_DONORS)throw Error('Pool is full (8 donors). Remove a donor before adding another.');
    const saved=this.replace(validateParkingPool(next));
    this.note(`Pool has ${next.length} donors · ${this.busy()?'queued for the next generation':'ready for the next evolution run'}. The active brain is unchanged.${saved?'':' Browser storage is full; export the pool to keep it.'}`);
  }
  private replace(pool:ParkingDonor[]){
    this.pool=pool;this.paint();this.note(`Pool now has ${pool.length} donor(s) · ${this.busy()?'changes queued for the next generation':'ready for evolution'}.`);let saved=true;try{localStorage.setItem(STORE,poolText(pool));}catch{saved=false;this.note('Pool is available in this tab; browser storage is full. Export it to keep the donors.');}
    this.log(`Gene pool: ${pool.length} donor(s); changes apply at the next generation boundary.`);window.dispatchEvent(new Event('flykart-genepool'));return saved;
  }
  private paint(){
    this.element.querySelector('[data-count]')!.textContent=`${this.pool.length} donor${this.pool.length===1?'':'s'}`;
    const list=this.element.querySelector('[data-donors]')!;list.replaceChildren();
    for(const donor of this.pool){const row=document.createElement('div');row.className='gene-pool-donor';const label=document.createElement('span');label.textContent=`${donor.name} · G${donor.generation} · ${donor.domain==='track'?'racer → parking adaptation':'world controller'} · ${donor.id}`;const remove=document.createElement('button');remove.textContent='Remove';remove.onclick=()=>this.replace(this.pool.filter(d=>d.id!==donor.id));row.append(label,remove);list.append(row);}
  }
}
