import { afterEach, describe, expect, it, vi } from 'vitest';
import { RobotSerial, SerialDevice } from './serial';

afterEach(()=>vi.unstubAllGlobals());
describe('USB command cancellation',()=>{
  it('drops queued ARM, AUTO and motor writes when STOP interrupts a slow UART',async()=>{
    const writes:string[]=[];let release!:()=>void;
    const port:SerialDevice={readable:new ReadableStream(),writable:new WritableStream({async write(bytes){const line=new TextDecoder().decode(bytes).trim();writes.push(line);if(writes.length===1)await new Promise<void>(r=>release=r);}}),async open(){},async close(){}};
    vi.stubGlobal('navigator',{serial:{requestPort:async()=>port}});vi.stubGlobal('isSecureContext',true);
    const serial=new RobotSerial(()=>{},()=>{},()=>{});await serial.connect(460800);
    const arm=serial.send('ARM');await vi.waitFor(()=>expect(writes).toEqual(['ARM']));
    const queued=[serial.send('M 80 80'),serial.send('AUTO 80 5'),serial.send('ARM')],stop=serial.send('STOP');
    release();await Promise.all([arm,...queued,stop]);expect(writes).toEqual(['ARM','STOP']);
    await serial.send('ARM');expect(writes.at(-1)).toBe('ARM');
    await serial.disconnect();
  });
});
