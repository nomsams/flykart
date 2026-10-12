import {createServer} from 'vite';
// Test pages must not reload when another developer edits unrelated files.
// Keep normal config/plugins and /src imports for browser fixtures.
const port=Number(process.argv[2]);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid browser check port');
const server=await createServer({server:{host:'127.0.0.1',port,strictPort:true,hmr:false}});
await server.listen();
console.log('Isolated browser check server ready; hot reload disabled.');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{void server.close().finally(()=>process.exit());});
