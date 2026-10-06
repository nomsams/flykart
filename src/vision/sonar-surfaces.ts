/** Qualitative training presets, not measured HC-SR04 material coefficients. */
export const SONAR_SURFACES = [
  {id:'legacy',label:'Original model · compatibility'},
  {id:'smooth',label:'Smooth / hard · specular'},
  {id:'rough',label:'Rough / hard · scattered'},
  {id:'soft',label:'Fabric / foam · absorbing'},
  {id:'foliage',label:'Foliage · weak scattered return'},
] as const;
export type SonarSurface=typeof SONAR_SURFACES[number]['id'];
export function validateSonarSurface(raw:unknown):SonarSurface {
  if(!SONAR_SURFACES.some(s=>s.id===raw))throw Error('Unknown sonar surface preset.');
  return raw as SonarSurface;
}
export function reflectionGain(surface:SonarSurface|undefined,incidence:number,roundish:boolean):number {
  const legacy=roundish?1:Math.exp(-((Math.max(0,incidence-.26)/.31)**2));
  switch(surface){
    case 'smooth':return Math.exp(-((Math.max(0,incidence-.12)/.18)**2));
    case 'rough':return .55*(.12+.88*Math.cos(incidence)**2);
    case 'soft':return .04*(.2+.8*Math.cos(incidence)**2);
    case 'foliage':return .18*(.25+.75*Math.cos(incidence)**2);
    default:return legacy;
  }
}
