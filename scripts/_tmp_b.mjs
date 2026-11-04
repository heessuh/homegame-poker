import { createHmac, createHash, randomBytes } from "node:crypto";
const key = randomBytes(32), N=300000;
let t=Date.now(); for(let i=0;i<N;i++) createHmac("sha256",key).update("mochapoker-v1|tabc12|123|pabc123:0123456789abcdef0123456789abcdef|"+(i&7)).digest();
console.log("hmac",(Date.now()-t)/N*1000,"us");
const ip=Buffer.alloc(64,0x36),op=Buffer.alloc(64,0x5c);for(let i=0;i<32;i++){ip[i]^=key[i];op[i]^=key[i]}
const ih=createHash("sha256").update(ip), oh=createHash("sha256").update(op);
t=Date.now(); for(let i=0;i<N;i++){const d=ih.copy().update("mochapoker-v1|tabc12|123|pabc123:0123456789abcdef0123456789abcdef|"+(i&7)).digest(); oh.copy().update(d).digest();}
console.log("copy",(Date.now()-t)/N*1000,"us");
