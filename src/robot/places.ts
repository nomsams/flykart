import type { Pose } from './model';
import { angle, StateEstimator } from './state-estimator';
export type Place={id:number;features:number[];pose:Pose;variance:number;visits:number;reward:boolean};
export type PlaceGraph={version:1;nodes:Place[];edges:[number,number,number][]};
const distance=(a:number[],b:number[])=>a.reduce((sum,v,i)=>sum+(v-b[i])**2,0)/a.length;
/** View-dependent topology, with repeated matches and an ambiguity margin. No world truth input. */
export class VisualPlaces {
  nodes:Place[]=[];edges:[number,number,number][]=[];current:number|null=null;status='No visual places';private pending=-1;private repeats=0;
  reset():void {this.current=null;this.pending=-1;this.repeats=0;}
  observe(features:number[],e:StateEstimator,time:number):void {
    if(features.length!==24||features.some(v=>!Number.isFinite(v)))return;
    let variation=0;for(let channel=0;channel<3;channel++){const mean=features.filter((_,i)=>i%3===channel).reduce((a,b)=>a+b,0)/8;variation+=features.filter((_,i)=>i%3===channel).reduce((a,b)=>a+(b-mean)**2,0)/24;}if(variation<.0005){this.status='Low-detail view · no place anchor';return;}
    const p=e.pose, ranked=this.nodes.filter(n=>Math.abs(angle(n.pose.heading-p.heading))<.65).map(n=>({n,d:distance(features,n.features)})).sort((a,b)=>a.d-b.d),first=ranked[0];
    if(first&&first.d<.003){
      if(ranked[1]&&ranked[1].d-first.d<.001){this.status='Ambiguous view · no correction';return;}
      if(this.pending===first.n.id)this.repeats++;else{this.pending=first.n.id;this.repeats=1;}
      if(this.repeats<3){this.status='Confirming visual match';return;}
      const n=first.n;this.link(n.id,p);n.visits++;this.status=`Place ${n.id} · visual match`;
      // Relative map anchors are correlated. Keep a floor; never pretend a GPS fix.
      if(Math.hypot(n.pose.x-p.x,n.pose.z-p.z)>.12)e.observe(n.pose,Math.sqrt(Math.max(.04,n.variance)),.3,time,'relative visual place');
      return;
    }
    if(this.nodes.some(n=>Math.hypot(n.pose.x-p.x,n.pose.z-p.z)<.35&&Math.abs(angle(n.pose.heading-p.heading))<.5)){this.status='Within an existing place';return;}
    if(this.nodes.length>=256){this.status='Place graph full · 256 places';return;}
    const n:Place={id:this.nodes.length,features:[...features],pose:{...p},variance:Math.max(e.covariance[0],e.covariance[4]),visits:1,reward:false};this.nodes.push(n);this.link(n.id,p);this.status=`Learned place ${n.id}`;
  }
  private link(id:number,p:Pose):void {if(this.current!==null&&this.current!==id&&!this.edges.some(([a,b])=>a===this.current&&b===id||a===id&&b===this.current)){const from=this.nodes[this.current];this.edges.push([this.current,id,Math.max(.1,Math.hypot(from.pose.x-p.x,from.pose.z-p.z))]);}this.current=id;}
  sugar():void {if(this.current!==null)this.nodes[this.current].reward=true;}
  route():number[] {
    if(this.current===null)return [];const queue=[this.current],previous=new Map<number,number|null>([[this.current,null]]);let goal:number|null=null;
    for(let k=0;k<queue.length;k++){const id=queue[k];if(this.nodes[id].reward){goal=id;break;}for(const [a,b]of this.edges){const next=a===id?b:b===id?a:null;if(next!==null&&!previous.has(next)){previous.set(next,id);queue.push(next);}}}
    if(goal===null)return [];const path:number[]=[];let at:number|null=goal;while(at!==null){path.unshift(at);at=previous.get(at)??null;}return path;
  }
  cue(p:Pose):{bearing:number;strength:number}|null {const route=this.route(),node=this.nodes[route[1]??route[0]];if(!node)return null;const d=Math.hypot(node.pose.x-p.x,node.pose.z-p.z);if(d<.15)return null;return {bearing:Math.max(-.25,Math.min(.25,angle(Math.atan2(node.pose.z-p.z,node.pose.x-p.x)-p.heading)*.2)),strength:Math.max(.05,.4/(1+node.variance*10))};}
  toJSON():PlaceGraph {return structuredClone({version:1,nodes:this.nodes,edges:this.edges});}
  static fromJSON(raw:unknown):VisualPlaces {const g=raw as PlaceGraph;if(!g||g.version!==1||!Array.isArray(g.nodes)||g.nodes.length>256||!Array.isArray(g.edges)||g.edges.length>32768||g.nodes.some((n,i)=>n.id!==i||!Array.isArray(n.features)||n.features.length!==24||n.features.some(v=>!Number.isFinite(v)||v<0||v>1)||![n.pose?.x,n.pose?.z,n.pose?.heading,n.variance,n.visits].every(Number.isFinite)||Math.abs(n.pose.x)>1000||Math.abs(n.pose.z)>1000||n.variance<0||n.visits<1||typeof n.reward!=='boolean')||g.edges.some(e=>!Array.isArray(e)||e.length!==3||!Number.isInteger(e[0])||!Number.isInteger(e[1])||!g.nodes[e[0]]||!g.nodes[e[1]]||!Number.isFinite(e[2])||e[2]<=0))throw new Error('Invalid place graph.');const p=new VisualPlaces();p.nodes=structuredClone(g.nodes);p.edges=structuredClone(g.edges);return p;}
}
