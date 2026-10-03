import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_ROBOT, ESP_WIRING } from "../src/robot/model";
import { bridgeSketch } from "../src/robot/esp32-bridge";

const args=Object.fromEntries(process.argv.slice(2).map(a=>a.replace(/^--/,"").split("=")));
const lab=args.lab ? JSON.parse(readFileSync(resolve(args.lab),"utf8")) : null;
const folder=resolve(args.out??".cache/firmware-verify/flykart_bridge");
mkdirSync(folder,{recursive:true});
writeFileSync(resolve(folder,"flykart_bridge.ino"),bridgeSketch(lab?.wiring??ESP_WIRING,lab?.config??DEFAULT_ROBOT));
console.log(`Generated ${folder}/flykart_bridge.ino`);
