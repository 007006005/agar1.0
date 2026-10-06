const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 3322);
const WIDTH = 12000, HEIGHT = 12000;
const TICK = 50;
let nextId = 1;
const clients = new Set();
const cells = new Map();

function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
function rand(a,b){ return a + Math.random()*(b-a); }
function color(){ return [Math.floor(rand(50,240)),Math.floor(rand(50,240)),Math.floor(rand(50,240))]; }

function str16(s){
  const b=Buffer.alloc(2*(s.length+1));
  for(let i=0;i<s.length;i++) b.writeUInt16LE(s.charCodeAt(i),i*2);
  return b;
}
function pktBorder(){
  const b=Buffer.alloc(1+32); b[0]=64;
  b.writeDoubleLE(-WIDTH/2,1); b.writeDoubleLE(-HEIGHT/2,9);
  b.writeDoubleLE(WIDTH/2,17); b.writeDoubleLE(HEIGHT/2,25); return b;
}
function pktAdd(id){ const b=Buffer.alloc(5); b[0]=32; b.writeUInt32LE(id,1); return b; }
function pktClear(){ return Buffer.from([20]); }
function pktPos(c){ const b=Buffer.alloc(13); b[0]=17; b.writeFloatLE(c.x,1); b.writeFloatLE(c.y,5); b.writeFloatLE(c.size,9); return b; }
function pktLB(){
  const list=[...clients].filter(c=>c.alive).sort((a,b)=>b.score-a.score).slice(0,10);
  const parts=[Buffer.from([49]),Buffer.alloc(4)]; parts[1].writeUInt32LE(list.length,0);
  for(const c of list){ const id=Buffer.alloc(4); id.writeUInt32LE(c.cellId,0); parts.push(id,str16(c.name||'UnnamedCell')); }
  return Buffer.concat(parts);
}
function pktUpdate(){
  const parts=[Buffer.from([16]),Buffer.alloc(2)]; parts[1].writeUInt16LE(0,0);
  for(const c of cells.values()){
    const name=str16(c.name||'');
    const h=Buffer.alloc(4+2+2+2+3+1);
    h.writeUInt32LE(c.id,0); h.writeInt16LE(Math.round(c.x),4); h.writeInt16LE(Math.round(c.y),6); h.writeInt16LE(Math.round(c.size),8);
    h[10]=c.color[0]; h[11]=c.color[1]; h[12]=c.color[2]; h[13]=c.virus?1:0;
    parts.push(h,name);
  }
  parts.push(Buffer.alloc(4)); // terminator node id
  const rem=Buffer.alloc(4); rem.writeUInt32LE(0,0); parts.push(rem);
  return Buffer.concat(parts);
}
function broadcast(buf){ for(const c of clients) if(c.ws.readyState===1) c.ws.send(buf); }

function makeCell(client, size=45){
  const id=nextId++; const c={id,x:rand(-5000,5000),y:rand(-5000,5000),size,color:color(),name:client.name||'UnnamedCell',clientId:client.id,virus:false};
  cells.set(id,c); client.cellId=id; client.alive=true; client.score=Math.round(size*size/100); return c;
}
function spawnFood(n=220){
  for(let i=0;i<n;i++){ const id=nextId++; cells.set(id,{id,x:rand(-5800,5800),y:rand(-5800,5800),size:8+Math.floor(Math.random()*8),color:color(),name:'',clientId:null,virus:false}); }
}
spawnFood();

function parseString(buf,start){ let s=''; for(let p=start;p+1<buf.length;p+=2){const ch=buf.readUInt16LE(p);if(!ch)return [s,p+2];s+=String.fromCharCode(ch);} return [s,buf.length]; }
function dist2(a,b){const dx=a.x-b.x,dy=a.y-b.y;return dx*dx+dy*dy;}
function handle(c,data){
  if(!Buffer.isBuffer(data)) data=Buffer.from(data);
  const op=data[0];
  if(op===16 && data.length>=17){ c.targetX=data.readDoubleLE(1); c.targetY=data.readDoubleLE(9); }
  else if(op===192){ [c.name]=parseString(data,1); const cell=c.cellId&&cells.get(c.cellId); if(cell)cell.name=c.name||'UnnamedCell'; }
  else if(op===17) split(c);
  else if(op===21) eject(c);
  else if(op===1) spectate(c);
  else if(op===206){ const flags=data[1]||0; const [name,p]=parseString(data,2); const [message]=parseString(data,p); chat(c,name,message,flags); }
}
function split(c){ const p=c.cellId&&cells.get(c.cellId); if(!p||!c.alive)return; if(p.size<35)return; p.size*=0.71; const id=nextId++; const angle=Math.random()*Math.PI*2; const q={id,x:clamp(p.x+Math.cos(angle)*p.size*2,-5900,5900),y:clamp(p.y+Math.sin(angle)*p.size*2,-5900,5900),size:p.size,color:p.color.slice(),name:p.name,clientId:c.id,virus:false}; cells.set(id,q); c.cellId=id; }
function eject(c){ const p=c.cellId&&cells.get(c.cellId); if(!p||p.size<30)return; p.size-=2; const id=nextId++; const angle=Math.random()*Math.PI*2; cells.set(id,{id,x:p.x+Math.cos(angle)*p.size,y:p.y+Math.sin(angle)*p.size,size:12,color:p.color.slice(),name:'',clientId:null,virus:false}); }
function spectate(c){ const first=[...clients].find(x=>x.alive); if(first)c.cellId=first.cellId; }
function chat(c,name,message,flags){ if(!message||message.length>500)return; const b=Buffer.concat([Buffer.from([99,flags&1]),Buffer.from([name?1:0]),Buffer.alloc(0)]); const payload=Buffer.concat([Buffer.from([99,0,c.cellId?200:120]),str16(c.name||'UnnamedCell'),str16(message)]); broadcast(payload); }

const httpServer=http.createServer((req,res)=>{ if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({ok:true,service:'ZeroLegend Agar WebSocket',players:[...clients].length,port:PORT}));} res.writeHead(200);res.end('ZeroLegend Agar server online'); });
const wss=new WebSocketServer({server:httpServer,perMessageDeflate:false});
wss.on('connection',(ws,req)=>{
  const c={ws,id:Math.random().toString(36).slice(2),name:'UnnamedCell',cellId:0,alive:false,score:0,targetX:0,targetY:0}; clients.add(c);
  ws.binaryType='arraybuffer'; ws.send(pktBorder()); makeCell(c); ws.send(pktAdd(c.cellId)); ws.send(pktLB());
  ws.on('message',d=>{try{handle(c,Buffer.from(d));}catch(e){}});
  ws.on('close',()=>{if(c.cellId)cells.delete(c.cellId);clients.delete(c);});
  ws.on('error',()=>{});
});

setInterval(()=>{
  for(const c of clients){ const p=c.cellId&&cells.get(c.cellId); if(!p)continue; const dx=c.targetX-p.x,dy=c.targetY-p.y, len=Math.hypot(dx,dy); const speed=Math.max(1.5,1800/(p.size+100)); if(len>2){p.x=clamp(p.x+dx/len*speed,-5900,5900);p.y=clamp(p.y+dy/len*speed,-5900,5900);} p.name=c.name||'UnnamedCell'; }
  // simple food consumption
  for(const c of clients){ const p=c.cellId&&cells.get(c.cellId); if(!p)continue; for(const f of cells.values()){ if(f.clientId!==null||f.size>16)continue; if(dist2(p,f)<(p.size+f.size)**2){p.size+=0.35;cells.delete(f.id);} } }
  if(cells.size<120)spawnFood(100);
  const up=pktUpdate(); const posClients=[...clients]; for(const c of posClients) if(c.ws.readyState===1){c.ws.send(up);c.ws.send(pktPos(c.cellId&&cells.get(c.cellId)||{x:0,y:0,size:1}));} broadcast(pktLB());
},TICK);

httpServer.listen(PORT,'0.0.0.0',()=>console.log(`ZeroLegend Agar server listening on ${PORT}`));
