/** Independent worlds, common seeds: ghosts never block one another. */
export async function runCohort<T extends {done:boolean;step():void}>(sessions:T[], cancelled:()=>boolean, progress:(sessions:T[])=>void, speed=0):Promise<boolean>{
  let last=performance.now();
  while(sessions.some(s=>!s.done)){
    if(cancelled())return false;
    const start=performance.now();let rounds=0;
    do{for(const session of sessions)if(!session.done)session.step();rounds++;}
    while(sessions.some(s=>!s.done)&&performance.now()-start<12&&(speed===0||rounds<Math.max(1,speed)));
    const now=performance.now();if(now-last>65||sessions.every(s=>s.done)){progress(sessions);last=now;}
    await new Promise<void>(resolve=>setTimeout(resolve,speed===0?0:Math.max(0,rounds*1000/(30*speed)-(performance.now()-start))));
  }
  progress(sessions);return !cancelled();
}
