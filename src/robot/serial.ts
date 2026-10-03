import { BridgeFrame, parseBridgeFrame } from "./esp32-bridge";

export type SerialDevice = { readable: ReadableStream<Uint8Array> | null; writable: WritableStream<Uint8Array> | null; open(options: { baudRate: number; bufferSize: number }): Promise<void>; close(): Promise<void> };
export type SerialApi = { requestPort(): Promise<SerialDevice> };
export const serialApi = () => (navigator as Navigator & { serial?: SerialApi }).serial;
export type FlashImage = { name: string; address: number; data: Uint8Array };
export function validateFlash(images: FlashImage[]): FlashImage[] {
  if (!images.length || images.length > 4) throw new Error("Choose one merged binary, or up to four compiled binary segments.");
  const sorted = images.slice().sort((a,b)=>a.address-b.address);
  for (const [i, image] of sorted.entries()) {
    if (!Number.isInteger(image.address) || image.address < 0 || image.address % 4096 || !image.data.length || image.address + image.data.length > 4*1024*1024) throw new Error(`${image.name}: choose a 4 KB-aligned offset within the 4 MB flash profile.`);
    if (i && Math.ceil((sorted[i-1].address+sorted[i-1].data.length)/4096)*4096 > image.address) throw new Error("Flash segments overlap, including their erase sectors.");
  }
  return sorted;
}

export async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const field=document.createElement("textarea"); field.value=text; field.style.position="fixed"; field.style.opacity="0"; document.body.append(field); field.select();
    const copied=document.execCommand("copy"); field.remove(); if(!copied) throw new Error("Clipboard unavailable. Export the log as a file.");
  }
}

export class RobotSerial {
  private device: SerialDevice | null = null; private reader: ReadableStreamDefaultReader<Uint8Array> | null = null; private readerTask: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve(); private buffer="";
  constructor(private log: (text:string)=>void, private frame: (frame:BridgeFrame)=>void, private closed: ()=>void) {}
  get connected(): boolean { return this.device!==null; }
  async connect(baudRate: number): Promise<void> {
    if(this.connected) throw new Error("Disconnect the current serial port first.");
    const api=serialApi(); if(!api || !isSecureContext) throw new Error("Web Serial requires Chrome or Edge on localhost or HTTPS. Open this lab in that browser.");
    const port=await api.requestPort(); await port.open({baudRate,bufferSize:65536}); this.device=port; this.buffer="";
    this.log(`Serial connected · ${baudRate} baud`); this.readerTask=this.read();
  }
  send(line: string): Promise<void> {
    if(line.length>64 || /[\r\n]/.test(line)) return Promise.reject(new Error("Serial command must be a single short line."));
    const port=this.device;
    const operation=this.queue.then(async()=>{ if(!port?.writable || port!==this.device) throw new Error("Serial port disconnected."); const writer=port.writable.getWriter(); try { await writer.write(new TextEncoder().encode(line+"\n")); } finally { writer.releaseLock(); } });
    this.queue=operation.catch(()=>{}); return operation;
  }
  private async read(): Promise<void> {
    const decoder=new TextDecoder();
    try {
      while(this.device?.readable) {
        this.reader=this.device.readable.getReader();
        try {
          while(this.device) { const {value,done}=await this.reader.read(); if(done) break;
            this.buffer+=decoder.decode(value,{stream:true});
            let end:number; while((end=this.buffer.indexOf("\n"))>=0) { const line=this.buffer.slice(0,end).replace(/\r$/," ").trimEnd(); this.buffer=this.buffer.slice(end+1);
              const frame=parseBridgeFrame(line); if(frame) this.frame(frame); else if(line) this.log(line.slice(0,500));
            }
            if(this.buffer.length>60000) throw new Error("Serial line exceeds the bridge protocol limit.");
          }
        } finally { this.reader.releaseLock(); this.reader=null; }
        break;
      }
    } catch(error) { this.log(`Serial read error: ${error instanceof Error ? error.message : error}`); }
    finally { const port=this.device;this.device=null;this.closed();if(port){await this.queue;try{await port.close();}catch{/* USB unplugged */}} }
  }
  async disconnect(): Promise<void> {
    const port=this.device; if(!port) return;
    try { await this.send("STOP"); } catch { /* unplugged */ }
    this.device=null; await this.reader?.cancel().catch(()=>{}); await this.readerTask; await this.queue;
    try { await port.close(); } catch(error) { this.log(`Port close: ${String(error)}`); }
    this.log("Serial disconnected");
  }
}

/** Binary flashing is separate from C++ compilation and from the serial monitor. */
export async function flashEsp32(images: FlashImage[], log: (text:string)=>void, progress: (percent:number)=>void): Promise<void> {
  const files=validateFlash(images), api=serialApi(); if(!api) throw new Error("Web Serial is unavailable. Use Chrome or Edge.");
  // Request the user's device from this button gesture, before loading the flasher.
  const port=await api.requestPort(); const {ESPLoader,Transport}=await import("esptool-js");
  const transport=new Transport(port as unknown as ConstructorParameters<typeof Transport>[0]);
  try {
    const loader=new ESPLoader({transport,baudrate:115200,terminal:{clean:()=>{},writeLine:log,write:log}});
    const chip=await loader.main(); log(`Detected ${chip}`);
    if(!/^ESP32(?:-|$)/.test(chip) || /S[23]|C[236]/.test(chip)) throw new Error("This binary profile targets classic ESP32, not S2/S3/C-series chips.");
    const {md5}=await import("js-md5");
    await loader.writeFlash({fileArray:files.map(f=>({data:f.data,address:f.address})),flashMode:"dio",flashFreq:"40m",flashSize:"4MB",eraseAll:false,compress:true,calculateMD5Hash:data=>md5(data),reportProgress:(i,written,total)=>progress((i+written/total)/files.length*100)});
    log("Firmware write completed. Remove GPIO0-to-GND boot link, then reset the ESP32-CAM."); await loader.after("hard_reset");
  } finally { await transport.disconnect(); }
}

export function decodeRgb565(bytes: Uint8Array, littleEndian=false): Uint8ClampedArray {
  if(bytes.length%2)throw new Error("RGB565 needs paired bytes.");
  const result=new Uint8ClampedArray(bytes.length*2);
  for(let i=0;i<bytes.length;i+=2) { const v=littleEndian ? bytes[i]|bytes[i+1]<<8 : bytes[i]<<8|bytes[i+1], j=i*2;
    result[j]=Math.round((v>>11)/31*255); result[j+1]=Math.round((v>>5&63)/63*255); result[j+2]=Math.round((v&31)/31*255); result[j+3]=255;
  }
  return result;
}
