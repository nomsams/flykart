/** Cooperative zero-delay work uses messages rather than background-clamped window timers. */
export function cohortYield(){
  const channel=new MessageChannel();
  return{
    wait(delay:number){return new Promise<void>(resolve=>{if(delay>0)setTimeout(resolve,delay);else{channel.port1.onmessage=()=>resolve();channel.port2.postMessage(null);}});},
    close(){channel.port1.close();channel.port2.close();},
  };
}
