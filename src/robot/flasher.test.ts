import { afterEach, describe, expect, it, vi } from "vitest";
import { flashEsp32 } from "./serial";
const state=vi.hoisted(()=>({writes:[] as unknown[],disconnected:0,chip:"ESP32-D0WD",fail:false}));
vi.mock("esptool-js",()=>({
  Transport:class{async disconnect(){state.disconnected++;}},
  ESPLoader:class{async main(){return state.chip;}async writeFlash(options:{eraseAll:boolean;calculateMD5Hash:(data:Uint8Array)=>string}){state.writes.push(options);if(state.fail)throw new Error("USB failure");expect(options.calculateMD5Hash(new Uint8Array([97]))).toBe("0cc175b9c0f1b6a831c399e269772661");}async after(){}}
}));
afterEach(()=>{vi.unstubAllGlobals();state.writes=[];state.disconnected=0;state.chip="ESP32-D0WD";state.fail=false;});
describe("ESP32 flasher orchestration",()=>{
  const image={name:"app.bin",address:0x10000,data:new Uint8Array([97])};
  const setup=()=>vi.stubGlobal("navigator",{serial:{requestPort:async()=>({})}});
  it("uses reviewed offsets, verifies MD5 and avoids full-chip erase",async()=>{setup();await flashEsp32([image],()=>{},()=>{});expect(state.writes[0]).toMatchObject({eraseAll:false,fileArray:[{address:0x10000,data:image.data}]});expect(state.disconnected).toBe(1);});
  it("rejects other ESP families before writing and closes on failure",async()=>{setup();state.chip="ESP32-S3";await expect(flashEsp32([image],()=>{},()=>{})).rejects.toThrow(/classic/);expect(state.writes).toHaveLength(0);expect(state.disconnected).toBe(1);state.chip="ESP32-D0WD";state.fail=true;await expect(flashEsp32([image],()=>{},()=>{})).rejects.toThrow(/USB failure/);expect(state.disconnected).toBe(2);});
});
