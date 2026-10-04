import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
export type MeshBox={x:number;y:number;z:number;width:number;height:number;depth:number};
export type ObjectVisual={type:'image'|'glb';name:string;data:string;boxes?:MeshBox[]};
const models=new Map<string,{group:THREE.Group;boxes:MeshBox[]}>();
const images=new Map<string,THREE.Texture>();
function trimCache<T>(cache:Map<string,T>,limit:number,dispose:(value:T)=>void){while(cache.size>limit){const key=cache.keys().next().value!;dispose(cache.get(key)!);cache.delete(key);}}
function disposeModel(group:THREE.Group){group.traverse(o=>{if(o instanceof THREE.Mesh){o.geometry.dispose();for(const m of Array.isArray(o.material)?o.material:[o.material]){for(const value of Object.values(m))if(value instanceof THREE.Texture)value.dispose();m.dispose();}}});}
function cloneMaterial(material:THREE.Material){const clone=material.clone();for(const key of Object.keys(clone)){const value=(clone as unknown as Record<string,unknown>)[key];if(value instanceof THREE.Texture){const texture=value.clone();texture.userData.robotImported=true;(clone as unknown as Record<string,unknown>)[key]=texture;}}return clone;}
export function validateVisual(raw:unknown):ObjectVisual {
  const v=raw as ObjectVisual;
  if(!v||!['image','glb'].includes(v.type)||typeof v.name!=='string'||!v.name||v.name.length>100||typeof v.data!=='string')throw new Error('Invalid imported visual.');
  if(v.type==='image'){if(v.data.length>700000||!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(v.data))throw new Error('Image cards must be bounded PNG data.');}
  else {if(v.data.length>2800000||!/^[A-Za-z0-9+/]+={0,2}$/.test(v.data))throw new Error('GLB exceeds the portable 2 MB budget.');checkGlb(decode(v.data));}
  if(v.boxes&&(!Array.isArray(v.boxes)||v.boxes.length>64||v.boxes.some(b=>![b.x,b.y,b.z,b.width,b.height,b.depth].every(Number.isFinite)||Math.abs(b.x)>1||Math.abs(b.z)>1||b.y<0||b.y>1||[b.width,b.height,b.depth].some(n=>n<0||n>1.01))))throw new Error('Invalid model contact boxes.');
  return structuredClone(v);
}
const decode=(data:string)=>Uint8Array.from(atob(data),c=>c.charCodeAt(0)).buffer;
function checkGlb(buffer:ArrayBuffer):void{
  if(buffer.byteLength<28||buffer.byteLength>2_097_152)throw new Error('Import a self-contained GLB up to 2 MB.');
  const d=new DataView(buffer);
  if(d.getUint32(0,true)!==0x46546c67||d.getUint32(4,true)!==2||d.getUint32(8,true)!==buffer.byteLength||d.getUint32(16,true)!==0x4e4f534a||20+d.getUint32(12,true)>buffer.byteLength)throw new Error('Invalid GLB 2.0 file.');
  const json=JSON.parse(new TextDecoder().decode(buffer.slice(20,20+d.getUint32(12,true))).trim());
  if((json.extensionsRequired??[]).some((s:string)=>['KHR_draco_mesh_compression','EXT_meshopt_compression','KHR_texture_basisu'].includes(s)))throw new Error('Export an uncompressed GLB with PNG/JPEG textures for this lab.');
  for(const v of [...(json.buffers??[]),...(json.images??[])])if(v.uri&&!/^data:(image\/(png|jpeg)|application\/octet-stream);base64,/.test(v.uri))throw new Error('External model files are unsupported. Embed textures and buffers in the GLB.');
  if((json.meshes?.length??0)>64||(json.nodes?.length??0)>256)throw new Error('Model is too complex: use up to 64 meshes and 256 nodes.');
}
export async function prepareVisual(v:ObjectVisual):Promise<void>{
  validateVisual(v);
  if(v.type==='image'){
    if(images.has(v.data))return;
    const img=new Image();img.src=v.data;await img.decode();
    if(img.naturalWidth>256||img.naturalHeight>256)throw new Error('Portable image cards must be at most 256 pixels per side. Import the original image to resize it.');
    const texture=new THREE.Texture(img);texture.colorSpace=THREE.SRGBColorSpace;texture.needsUpdate=true;
    images.set(v.data,texture);trimCache(images,32,t=>t.dispose());return;
  }
  if(models.has(v.data)){v.boxes=structuredClone(models.get(v.data)!.boxes);return;}
  const gltf=await new GLTFLoader().parseAsync(decode(v.data),'');
  if(gltf.animations.length)throw new Error('Use a static GLB; animated target dynamics are not imported.');
  let vertices=0,meshes=0;
  gltf.scene.updateMatrixWorld(true);gltf.scene.traverse(o=>{if(o instanceof THREE.Mesh){vertices+=o.geometry.getAttribute('position')?.count??0;meshes++;if(o instanceof THREE.SkinnedMesh)throw new Error('Export a static mesh without skinning.');}});
  if(vertices>100000||!meshes||meshes>64)throw new Error('Use a static model with 1–64 meshes and up to 100,000 vertices.');
  const bounds=new THREE.Box3().setFromObject(gltf.scene),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());
  if(size.toArray().some(n=>!Number.isFinite(n)||n<.0001))throw new Error('The model needs nonzero width, depth and height.');
  const container=new THREE.Group();container.add(gltf.scene);gltf.scene.position.sub(new THREE.Vector3(center.x,bounds.min.y,center.z));container.scale.set(1/size.x,1/size.y,1/size.z);
  container.updateMatrixWorld(true);const boxes:MeshBox[]=[];
  container.traverse(o=>{if(o instanceof THREE.Mesh){const b=new THREE.Box3().setFromObject(o),s=b.getSize(new THREE.Vector3()),c=b.getCenter(new THREE.Vector3());boxes.push({x:c.x,y:c.y,z:c.z,width:s.x,height:s.y,depth:s.z});}});
  v.boxes=boxes;models.set(v.data,{group:container,boxes:structuredClone(boxes)});trimCache(models,16,m=>disposeModel(m.group));
}
export function visualMesh(v:ObjectVisual):THREE.Object3D|null{
  if(v.type==='image'){
    const source=images.get(v.data);if(!source)return null;const texture=source.clone();texture.userData.robotImported=true;
    const m=new THREE.Mesh(new THREE.PlaneGeometry(1,1),new THREE.MeshBasicMaterial({map:texture,side:THREE.DoubleSide,transparent:true,alphaTest:.1}));m.rotation.y=Math.PI/2;m.position.y=.5;const wrapper=new THREE.Group();wrapper.add(m);return wrapper;
  }
  const source=models.get(v.data);if(!source)return null;const clone=source.group.clone(true);
  clone.traverse(o=>{if(o instanceof THREE.Mesh){o.geometry=o.geometry.clone();o.material=Array.isArray(o.material)?o.material.map(cloneMaterial):cloneMaterial(o.material);}});const wrapper=new THREE.Group();wrapper.add(clone);return wrapper;
}
export async function importVisual(file:File):Promise<{visual:ObjectVisual;width:number;height:number;depth:number}>{
  if(file.name.toLowerCase().endsWith('.glb')){
    if(file.size>2_097_152)throw new Error('GLB limit: 2 MB.');const bytes=new Uint8Array(await file.arrayBuffer());let text='';for(const b of bytes)text+=String.fromCharCode(b);
    const visual:ObjectVisual={type:'glb',name:file.name.slice(0,100),data:btoa(text)};await prepareVisual(visual);return {visual,width:.2,height:.2,depth:.2};
  }
  if(!/^image\/(png|jpeg|webp)$/.test(file.type)||file.size>8_000_000)throw new Error('Import a PNG, JPEG or WebP up to 8 MB, or a self-contained GLB.');
  const bitmap=await createImageBitmap(file);if(bitmap.width*bitmap.height>20_000_000){bitmap.close();throw new Error('Image exceeds 20 megapixels.');}
  const canvas=document.createElement('canvas'),scale=Math.min(1,256/Math.max(bitmap.width,bitmap.height));canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));canvas.getContext('2d')!.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
  const visual:ObjectVisual={type:'image',name:file.name.slice(0,100),data:canvas.toDataURL('image/png')};await prepareVisual(visual);return {visual,width:.03,height:.2,depth:Math.max(.02,Math.min(1,.2*canvas.width/canvas.height))};
}
