import {spawn} from 'node:child_process';
import {once} from 'node:events';
const port=process.env.ROBOT_CHECK_PORT??'5185',url=`http://127.0.0.1:${port}`;
const checks=(process.env.ROBOT_BROWSER_CHECKS??'robot-target-studio-ui-check,robot-workbench-ui-check,robot-ui-check,robot-wiring-ui-check,robot-habitat-ui-check,robot-learning-ui-check,robot-training-ui-check,robot-research-ui-check,robot-lifecycle-ui-check,robot-bugfix-ui-check,robot-advanced-ui-check,robot-racing-ui-check,robot-vibration-ui-check').split(',');
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',port,'--strictPort'],{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',serverError;server.on('error',e=>{serverError=e;});for(const stream of [server.stdout,server.stderr])stream.on('data',b=>{output=(output+b).slice(-6000);});
try{
  let ready=false;for(let i=0;i<180;i++){if(serverError)throw serverError;if(server.exitCode!==null)throw Error(`Preview exited: ${output}`);try{const response=await fetch(url+'/robot.html',{signal:AbortSignal.timeout(2000)});if(response.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}if(!ready)throw Error(`Preview timeout: ${output}`);
  for(const name of checks){if(!/^robot-[a-z-]+-check$/.test(name))throw Error('Invalid browser check name');console.log(`Running ${name}`);const child=spawn(process.execPath,[`scripts/${name}.mjs`],{windowsHide:true,stdio:'inherit',env:{...process.env,ROBOT_LAB_URL:url}});const timer=setTimeout(()=>child.kill(),360000);try{const [code]=await once(child,'exit');if(code!==0)throw Error(`${name} exited ${code}`);}finally{clearTimeout(timer);}}
}finally{server.kill();await Promise.race([once(server,'exit'),new Promise(r=>setTimeout(r,3000))]);}
