// 水上base v2.2 — v2.1 world + v1.9 online community features
(()=>{'use strict';
const $=id=>document.getElementById(id);
const canvas=$('game');const ctx=canvas.getContext('2d');const mini=$('mini');const mc=mini.getContext('2d');
const W=7800,H=4800,CH=600,SPEED=150,CELL=55;
const params=new URLSearchParams(location.search);
const room=/^[\w-]{1,32}$/.test(params.get('room')||'')?params.get('room'):'main';
const password=params.get('password')||'';
const storageKey='mizukami-base-profile-v1';
let profile={name:'ゲスト',avatar:null};try{const p=JSON.parse(localStorage.getItem(storageKey)||'{}');if(typeof p.name==='string')profile.name=p.name.slice(0,16)||'ゲスト';if(typeof p.avatar==='string'&&/^data:image\/jpeg;base64,/.test(p.avatar)&&p.avatar.length<33000)profile.avatar=p.avatar;}catch{}
function saveProfile(){try{localStorage.setItem(storageKey,JSON.stringify(profile));}catch{}}
const make=(tag,cls,text)=>{const el=document.createElement(tag);el.className=cls;if(text!=null)el.textContent=text;return el};
let ownerToken=localStorage.getItem('mizukami-base-house-owner');if(!ownerToken||!/^[a-f0-9]{32}$/.test(ownerToken)){ownerToken=Array.from(crypto.getRandomValues(new Uint8Array(16)),v=>v.toString(16).padStart(2,'0')).join('');localStorage.setItem('mizukami-base-house-owner',ownerToken)}
const ownerId='owner-'+ownerToken;
const peers=new Map(),strokes=[];let ws=null,connected=false,myId=null,sendAt=0;let messages=[];
function send(data){if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(data))}

const hubs=[
 {id:'saijo',name:'西条市役所',kind:'hall',x:1550,y:1950,color:'#4e8fcd',board:'saijo'},
 {id:'shop',name:'水上塗装',kind:'shop',x:3960,y:2310,color:'#407eb0'},
 {id:'niihama',name:'新居浜市役所',kind:'hall',x:6390,y:1900,color:'#d47b70',board:'niihama'},
 {id:'dome',name:'水上ドーム',kind:'dome',x:4300,y:1030,color:'#8ac2db'}
];
const avatar={x:3900,y:2720};let tx=avatar.x,ty=avatar.y,vw=0,vh=0,dpr=1,zoom=1,last=performance.now(),route=[],placing=false,packing=false;
const keys=new Set();
const fract=x=>x-Math.floor(x);
function rnd(n){return fract(Math.sin(n*127.1+33.3)*43758.5453)}
function clamp(v,a,b){return Math.min(b,Math.max(a,v))}
function riverX(y,i){return (i===0?2520:5540)+125*Math.sin(y*.002+i*1.7)+42*Math.sin(y*.006+i)}
function river(x,y){return [0,1].some(i=>Math.abs(x-riverX(y,i))<52)}
const riverBridges=[1540,2660,3650];
function bridge(y){return riverBridges.some(v=>Math.abs(y-v)<70)}
function hrect(h){return h.kind==='dome'?{l:h.x-325,r:h.x+325,t:h.y-155,b:h.y+165}:{l:h.x-155,r:h.x+155,t:h.y-145,b:h.y+125}}
function distSegment(x,y,a,b){let vx=b[0]-a[0],vy=b[1]-a[1];let t=clamp(((x-a[0])*vx+(y-a[1])*vy)/(vx*vx+vy*vy||1),0,1);return Math.hypot(x-(a[0]+t*vx),y-(a[1]+t*vy))}
const gravel=[
 [[1550,2075],[1600,2390],[1850,2650],[2500,2700],[3200,2670],[3940,2700],[4620,2700],[5450,2630],[6390,2060]],
 [[3900,2710],[3890,2100],[4140,1650],[4300,1230]],
 [[1500,1950],[1770,1800],[2070,1630],[2400,1540],[3000,1630],[3500,1740],[4110,1760],[4630,1810],[5280,1670],[5920,1770],[6350,1890]],
 [[450,3460],[1400,3510],[2550,3530],[4000,3450],[5600,3490],[7000,3530]],
 [[1800,3530],[1900,3000],[1800,2730]],
 [[6200,3500],[6140,2900],[6380,2190]],
 [[4200,3510],[4360,2880]]
];
function gravelAt(x,y){for(let line of gravel)for(let i=1;i<line.length;i++)if(distSegment(x,y,line[i-1],line[i])<33)return true;return false}
function roadAt(x,y){return Math.abs(y-(2850+55*Math.sin(x*.0009)))<58}
function hillAt(x,y){return y>4200+150*Math.sin(x*.0014)+95*Math.sin(x*.004)}
function seaAt(x,y){return y<470+42*Math.sin(x*.0013)+37*Math.cos(x*.0036)}
function hubNear(x,y,pad=0){return hubs.some(h=>{let r=hrect(h);return x>r.l-pad&&x<r.r+pad&&y>r.t-pad&&y<r.b+pad})}
function treeListForChunk(ix,iy){const arr=[];for(let i=0;i<38;i++){
 const seed=ix*100000+iy*9271+i*13;const x=ix*CH+35+rnd(seed+12)*(CH-70),y=iy*CH+35+rnd(seed+51)*(CH-70);
 if(x<50||x>W-50||y<510||seaAt(x,y)||hillAt(x,y)||river(x,y)||roadAt(x,y)||gravelAt(x,y)||hubNear(x,y,220)||bridge(y)&&river(x,y)||rnd(seed+22)<.28)continue;
 arr.push({x,y,r:19+16*rnd(seed+110),type:Math.floor(rnd(seed+209)*4)});
 }return arr}
const trees=[];const bins=new Map();const BIN=100;
for(let iy=0;iy<Math.ceil(H/CH);iy++)for(let ix=0;ix<Math.ceil(W/CH);ix++)for(const t of treeListForChunk(ix,iy)){
 trees.push(t);const key=Math.floor(t.x/BIN)+','+Math.floor(t.y/BIN);if(!bins.has(key))bins.set(key,[]);bins.get(key).push(t)
}
function treeHit(x,y,radius=10){const c=Math.floor(x/BIN),r=Math.floor(y/BIN);for(let j=-1;j<=1;j++)for(let i=-1;i<=1;i++)for(const t of bins.get((c+i)+','+(r+j))||[])if(Math.hypot(x-t.x,y-t.y)<t.r*.63+radius)return true;return false}
let houses=[];function saveHouses(){}
function blocked(x,y,build=false){
 if(x<35||x>W-35||y<40||y>H-40||seaAt(x,y)||hillAt(x,y))return true;
 if(river(x,y)&&!bridge(y))return true;
 if(treeHit(x,y,build?85:8))return true;
 if(hubNear(x,y,build?235:25))return true;
 if(houses.some(h=>Math.hypot(x-h.x,y-h.y)<(build?170:76)))return true;
 if(build&&(roadAt(x,y)||gravelAt(x,y)||river(x,y)||y<650))return true;
 return false
}
function point(x,y){return {x,y}}
// A* with a small binary heap, so long paths across both towns stay responsive.
class Heap{constructor(){this.a=[]}push(v){let a=this.a,i=a.length;a.push(v);while(i){let p=(i-1)>>1;if(a[p].f<=v.f)break;a[i]=a[p];i=p}a[i]=v}pop(){const a=this.a,top=a[0],v=a.pop();if(a.length){let i=0;while(2*i+1<a.length){let l=2*i+1,r=l+1,c=r<a.length&&a[r].f<a[l].f?r:l;if(a[c].f>=v.f)break;a[i]=a[c];i=c}a[i]=v}return top}get size(){return this.a.length}}
const C=Math.ceil(W/CELL),R=Math.ceil(H/CELL),total=C*R;
const coords=id=>point((id%C+.5)*CELL,(Math.floor(id/C)+.5)*CELL);
function cellId(x,y){return clamp(Math.floor(y/CELL),0,R-1)*C+clamp(Math.floor(x/CELL),0,C-1)}
function nearbyFree(id){const q=coords(id);if(!blocked(q.x,q.y))return id;const c=id%C,r=Math.floor(id/C);for(let rad=1;rad<14;rad++)for(let yy=-rad;yy<=rad;yy++)for(let xx=-rad;xx<=rad;xx++){
 if(Math.max(Math.abs(xx),Math.abs(yy))!==rad)continue;const a=c+xx,b=r+yy;if(a<0||a>=C||b<0||b>=R)continue;const p=coords(b*C+a);if(!blocked(p.x,p.y))return b*C+a;
 }return -1}
function findPath(x,y){
 const start=nearbyFree(cellId(avatar.x,avatar.y)),goal=nearbyFree(cellId(x,y));if(start<0||goal<0)return[];
 if(start===goal)return[coords(goal)];
 const dist=new Float64Array(total);dist.fill(Infinity);const prev=new Int32Array(total);prev.fill(-1);const seen=new Uint8Array(total),heap=new Heap();
 dist[start]=0;const heur=id=>{let a=coords(id),b=coords(goal);return Math.hypot(a.x-b.x,a.y-b.y)};heap.push({id:start,f:heur(start)});
 const dirs=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
 let visited=0;
 while(heap.size&&visited<total){const {id}=heap.pop();if(seen[id])continue;seen[id]=1;visited++;if(id===goal)break;
 const cx=id%C,cy=Math.floor(id/C);for(let [dx,dy] of dirs){const nx=cx+dx,ny=cy+dy;if(nx<0||ny<0||nx>=C||ny>=R)continue;const nid=ny*C+nx;if(seen[nid])continue;const p=coords(nid);if(blocked(p.x,p.y))continue;
 if(dx&&dy){let a=coords(cy*C+nx),b=coords(ny*C+cx);if(blocked(a.x,a.y)||blocked(b.x,b.y))continue}
 const dd=dist[id]+(dx&&dy?1.414:1)*CELL;if(dd<dist[nid]){dist[nid]=dd;prev[nid]=id;heap.push({id:nid,f:dd+heur(nid)})}
 }}
 if(!seen[goal])return[];let ids=[];for(let id=goal;id!==start&&id>=0;id=prev[id]){ids.push(id);if(ids.length>total)return[]}
 ids.reverse();let pts=[];for(let i=0;i<ids.length;i++){const a=coords(ids[i]);pts.push(a)}return pts
}
function resize(){dpr=Math.min(window.devicePixelRatio||1,2);vw=window.innerWidth;vh=window.innerHeight;canvas.width=Math.round(vw*dpr);canvas.height=Math.round(vh*dpr)}
window.addEventListener('resize',resize);resize();
let cx=ctx;
function line(pts,w,color){cx.beginPath();cx.moveTo(pts[0][0],pts[0][1]);for(let i=1;i<pts.length;i++)cx.lineTo(pts[i][0],pts[i][1]);cx.lineWidth=w;cx.strokeStyle=color;cx.lineCap='round';cx.lineJoin='round';cx.stroke()}
function box(x,y,w,h,c){cx.fillStyle=c;cx.fillRect(x,y,w,h)}
function ellipse(x,y,rx,ry,c){cx.fillStyle=c;cx.beginPath();cx.ellipse(x,y,rx,ry,0,0,Math.PI*2);cx.fill()}
function txt(s,x,y,size=18,color='#264436',align='center',weight='800'){cx.font=`${weight} ${size}px system-ui`;cx.textAlign=align;cx.textBaseline='middle';cx.fillStyle=color;cx.fillText(s,x,y)}
function label(s,x,y,col='#264436'){cx.font='bold 20px system-ui';const ww=cx.measureText(s).width+34;cx.fillStyle='#f8f7e7f2';cx.strokeStyle=col;cx.lineWidth=3;cx.beginPath();cx.roundRect(x-ww/2,y-18,ww,36,9);cx.fill();cx.stroke();txt(s,x,y,19,col)}
function drawTree(t){ellipse(t.x+5,t.y+10,t.r*.8,t.r*.36,'#23552b63');box(t.x-4,t.y-6,8,25,'#795a37');ellipse(t.x-10,t.y-22,t.r*.83,t.r*.8,t.type===0?'#468e53':t.type===1?'#35836a':t.type===2?'#76a64d':'#45945e');ellipse(t.x+10,t.y-24,t.r*.71,t.r*.84,t.type===0?'#65b266':t.type===1?'#58b188':t.type===2?'#99ca6d':'#5cb875');ellipse(t.x-4,t.y-34,t.r*.63,t.r*.64,'#9ad378')}
function drawHouse(h){ellipse(h.x+5,h.y+33,72,20,'#244c3350');box(h.x-52,h.y-23,104,62,'#dbba88');cx.fillStyle=h.color||'#b87156';cx.beginPath();cx.moveTo(h.x-68,h.y-23);cx.lineTo(h.x,h.y-78);cx.lineTo(h.x+69,h.y-23);cx.fill();box(h.x-13,h.y+4,25,35,'#986341');box(h.x-43,h.y-10,19,20,'#7fb7bb');box(h.x+24,h.y-10,19,20,'#7fb7bb');}
function drawHub(h){const x=h.x,y=h.y;
 if(h.kind==='dome'){
  ellipse(x+5,y+100,340,68,'#174d4166');ellipse(x,y+30,315,135,'#3f7e99');ellipse(x,y,303,153,'#e2edfa');cx.fillStyle='#96bdd8';cx.beginPath();cx.ellipse(x,y-18,285,135,0,Math.PI,0);cx.fill();
  for(let i=-3;i<=3;i++){cx.strokeStyle='#ffffffa3';cx.lineWidth=3;cx.beginPath();cx.ellipse(x,y-18,285-Math.abs(i)*20,135,0,Math.PI,0);cx.stroke()}
  box(x-243,y+31,486,76,'#6b91ad');for(let i=-5;i<=5;i++)box(x+i*42-13,y+36,27,63,'#b6dfe9');label('🏟️ 水上ドーム',x,y+145,'#31719b');ellipse(x,y+225,89,25,'#aee1ee');ellipse(x,y+224,34,10,'#58b6d5');
 }else{
  ellipse(x+7,y+81,155,38,'#28503666');box(x-127,y-18,254,108,h.kind==='shop'?'#c8ced1':'#e8dfca');cx.fillStyle=h.color;cx.beginPath();cx.moveTo(x-143,y-17);cx.lineTo(x,y-126);cx.lineTo(x+143,y-17);cx.closePath();cx.fill();box(x-17,y+32,34,57,'#9e7858');for(let i of [-2,-1,1,2])box(x+i*49-11,y+5,22,26,'#a3d9ea');if(h.kind==='hall'){box(x-18,y-100,36,40,'#f5f4e6');ellipse(x,y-82,10,10,'#9ca7a1')}label(h.name,x,y+130,h.kind==='shop'?'#2a688d':'#426257');if(h.board){box(x+187,y+47,65,50,'#795436');box(x+193,y+52,53,35,'#efdbab');txt('📌',x+219,y+72,24)}
 }
}
function riverPath(i,top,bottom){const pts=[];for(let y=top-30;y<=bottom+30;y+=22)pts.push([riverX(y,i),y]);return pts}
function paintGround(ix,iy){const x=ix*CH,y=iy*CH;box(x,y,CH,CH,'#a9d880');for(let k=0;k<140;k++){const xx=x+rnd(ix*1013+iy*33+k)*CH,yy=y+rnd(ix*773+iy*919+k+110)*CH;ellipse(xx,yy,2+rnd(k+ix)*4,2+rnd(k+iy)*3,k%3?'#8bc870':'#b8df91')} 
 // northern sea and southern mountain transitions are geographic motifs, not exact GIS data.
 if(y<850){cx.beginPath();cx.moveTo(x,y);for(let xx=x;xx<=x+CH+30;xx+=18)cx.lineTo(xx,470+42*Math.sin(xx*.0013)+37*Math.cos(xx*.0036));cx.lineTo(x+CH,y);cx.closePath();cx.fillStyle='#80c8ec';cx.fill();for(let i=0;i<18;i++){let xx=x+rnd(ix*343+iy*92+i)*CH,yy=y+rnd(ix*218+iy*31+i+33)*CH;if(seaAt(xx,yy))ellipse(xx,yy,12,2,'#e1f7ff80')}}
 if(y>3600){cx.beginPath();cx.moveTo(x,y+CH);cx.lineTo(x,y);for(let xx=x;xx<=x+CH+30;xx+=12)cx.lineTo(xx,4200+150*Math.sin(xx*.0014)+95*Math.sin(xx*.004));cx.lineTo(x+CH,y+CH);cx.closePath();cx.fillStyle='#6eaa6c';cx.fill()}
 for(let i=0;i<2;i++){const pts=riverPath(i,y,y+CH);line(pts,130,'#799c63');line(pts,111,'#dec993');line(pts,100,'#398fbc');line(pts,84,'#71cae7')}
 // national road east-west, slightly winding
 const rd=[];for(let xx=x-30;xx<=x+CH+40;xx+=25)rd.push([xx,2850+55*Math.sin(xx*.0009)]);line(rd,125,'#d1c6a0');line(rd,102,'#74868a');line(rd,2,'#fff4bd');
 // gravel network is retained as independent geometry
 for(let pts of gravel){const minx=Math.min(...pts.map(v=>v[0])),maxx=Math.max(...pts.map(v=>v[0])),miny=Math.min(...pts.map(v=>v[1])),maxy=Math.max(...pts.map(v=>v[1]));if(maxx<x-80||minx>x+CH+80||maxy<y-80||miny>y+CH+80)continue;line(pts,69,'#aa8856');line(pts,54,'#e2c395');line(pts,3,'#edd8b9')}
 // bridges align exactly with river crossings
 for(const by of riverBridges)if(by>y-95&&by<y+CH+95)for(let i=0;i<2;i++){
 const rx=riverX(by,i);box(rx-86,by-72,172,144,'#896947');for(let j=0;j<6;j++)box(rx-77+j*28,by-69,5,138,'#d5b07b');
 }
 for(const t of trees)if(t.x>x-60&&t.x<x+CH+60&&t.y>y-60&&t.y<y+CH+60)drawTree(t);
 for(let k=0;k<16;k++){const xx=x+CH*rnd(ix*611+iy*991+k+31),yy=y+CH*rnd(ix*199+iy*771+k+64);if(!seaAt(xx,yy)&&!river(xx,yy)&&!roadAt(xx,yy)&&!gravelAt(xx,yy)&&!hillAt(xx,yy))ellipse(xx,yy,5,3,k%2?'#ffbed4':'#fff2a8')}
}
const caches=new Map(),MAX_CACHE=28;
function chunk(ix,iy){const key=ix+','+iy;if(caches.has(key)){const c=caches.get(key);caches.delete(key);caches.set(key,c);return c}
 const off=document.createElement('canvas');off.width=CH;off.height=CH;const old=cx;cx=off.getContext('2d');cx.translate(-ix*CH,-iy*CH);paintGround(ix,iy);cx=old;caches.set(key,off);if(caches.size>MAX_CACHE)caches.delete(caches.keys().next().value);return off}
function draw(){cx=ctx;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,vw,vh);ctx.fillStyle='#9cc7dc';ctx.fillRect(0,0,vw,vh);ctx.save();ctx.translate(vw/2-tx*zoom,vh/2-ty*zoom);ctx.scale(zoom,zoom);
 const left=tx-vw/zoom/2,top=ty-vh/zoom/2,right=tx+vw/zoom/2,bottom=ty+vh/zoom/2;
 for(let y=Math.max(0,Math.floor(top/CH));y<=Math.min(Math.ceil(H/CH)-1,Math.floor(bottom/CH));y++)for(let x=Math.max(0,Math.floor(left/CH));x<=Math.min(Math.ceil(W/CH)-1,Math.floor(right/CH));x++){
 ctx.drawImage(chunk(x,y),x*CH,y*CH)
 }
 const objects=[];
 for(const h of hubs)if(h.x>left-350&&h.x<right+350&&h.y>top-200&&h.y<bottom+240)objects.push({y:h.y+110,draw:()=>drawHub(h)});
 for(const h of houses)if(h.x>left-120&&h.x<right+120&&h.y>top-100&&h.y<bottom+90)objects.push({y:h.y+40,draw:()=>drawHouse(h)});
 for(const [id,p] of peers){if(id===myId)continue;const x=p.x*W,y=p.y*H;if(x<left-180||x>right+180||y<top-180||y>bottom+180)continue;
  objects.push({y:y+45,draw:()=>drawAvatar(x,y,p,p.name)});
 }
 objects.push({y:avatar.y+45,draw:()=>drawAvatar(avatar.x,avatar.y,{avatar:profile.avatar},profile.name+'（自分）')});
 objects.sort((a,b)=>a.y-b.y).forEach(v=>v.draw());
 if(placing){const x=avatar.x,y=avatar.y;label('🏡 空き地をクリック',x,y-95,'#567e60')}
 ctx.restore();drawMini();const near=nearestHub();$('loc').firstChild.textContent='📍 '+near.name+' 周辺';$('coords').textContent=`現在地 ${Math.round(avatar.x)}, ${Math.round(avatar.y)} / 広域 ${W}×${H}`
}
// Chat bubbles are rendered in CSS-screen pixels so they remain readable at any zoom.
// Keep every player's six most recent unexpired bubbles, each in its own comic-style panel.
function bubbleLines(text,maxWidth,fontPx=12){
 cx.font=`${fontPx}px sans-serif`;
 const out=[];
 for(const paragraph of String(text).split('\n')){
  let line='';
  for(const glyph of Array.from(paragraph)){
   if(line && cx.measureText(line+glyph).width>maxWidth){out.push(line);line=glyph;}
   else line+=glyph;
  }
  out.push(line);
 }
 return out.length?out:[''];
}
function drawSpeechStack(x,y,playerId,isMe){
 const now=performance.now();
 const recent=messages.filter(m=>m.until>now&&(isMe?m.id===myId:m.id===playerId)).slice(-6);
 if(!recent.length)return;
 cx.save();
 // Draw newest closest to the head, older ones above it. Never overlap the 48px avatar.
 const screenX=x*zoom,screenY=y*zoom;
 const fontPx=12, lineHeight=17, paddingX=11,paddingY=7,gap=9;
 const maxBoxPx=Math.max(120,Math.min(220,vw*.42));
 let liftedPx=61;
 for(let index=recent.length-1;index>=0;index--){
  const m=recent[index];
  const lines=bubbleLines(m.text,maxBoxPx-paddingX*2,fontPx);
  const longest=Math.max(0,...lines.map(t=>cx.measureText(t).width));
  const widthPx=Math.min(maxBoxPx,Math.max(60,longest+paddingX*2));
  const heightPx=lines.length*lineHeight+paddingY*2;
  const stagger=index%2===0?-13:13;
  const bxPx=screenX-widthPx/2+stagger;
  const byPx=screenY-liftedPx-heightPx;
  // Convert screen-pixel geometry back to world space (canvas already zoomed).
  const bx=bxPx/zoom,by=byPx/zoom,w=widthPx/zoom,h=heightPx/zoom;
  cx.fillStyle='#fffdf3';cx.strokeStyle='#719e86';cx.lineWidth=1.4/zoom;
  cx.shadowColor='#153e3560';cx.shadowBlur=7/zoom;cx.shadowOffsetY=3/zoom;
  cx.beginPath();cx.roundRect(bx,by,w,h,10/zoom);cx.fill();cx.shadowColor='transparent';cx.stroke();
  // Small comic tail points toward the next bubble / avatar.
  const tailX=(screenX+(index%2===0?-5:7))/zoom;
  const tailBase=by+h;
  cx.fillStyle='#fffdf3';cx.beginPath();
  cx.moveTo(tailX-6/zoom,tailBase-0.6/zoom);
  cx.lineTo(tailX+5/zoom,tailBase-0.6/zoom);
  cx.lineTo(tailX+1/zoom,tailBase+7/zoom);
  cx.closePath();cx.fill();
  cx.strokeStyle='#719e86';cx.lineWidth=1.1/zoom;
  cx.beginPath();cx.moveTo(tailX-6/zoom,tailBase);
  cx.lineTo(tailX+1/zoom,tailBase+7/zoom);
  cx.lineTo(tailX+5/zoom,tailBase);cx.stroke();
  cx.font=`${fontPx/zoom}px sans-serif`;cx.textBaseline='middle';cx.textAlign='center';cx.fillStyle='#29473b';
  for(let j=0;j<lines.length;j++)cx.fillText(lines[j],bx+w/2,by+(paddingY+lineHeight*(j+.5))/zoom);
  liftedPx+=heightPx+gap+7;
 }
 cx.restore();
}
const avatarCache=new Map();function drawAvatar(x,y,p,name){
 const size=48/zoom;ellipse(x+2,y+15/zoom,21/zoom,7/zoom,'#34584366');
 cx.save();cx.beginPath();cx.arc(x,y-20/zoom,size/2,0,Math.PI*2);cx.clip();
 cx.fillStyle='#f7f2de';cx.fillRect(x-size/2,y-20/zoom-size/2,size,size);
 if(p.avatar){let img=avatarCache.get(p.avatar);if(!img){img=new Image();img.src=p.avatar;avatarCache.set(p.avatar,img);if(avatarCache.size>32)avatarCache.delete(avatarCache.keys().next().value)}if(img.complete&&img.naturalWidth)cx.drawImage(img,x-size/2,y-20/zoom-size/2,size,size)}else{cx.font=`${28/zoom}px sans-serif`;cx.textAlign='center';cx.textBaseline='middle';cx.fillText('🙂',x,y-20/zoom)}cx.restore();
 cx.strokeStyle='#fff';cx.lineWidth=2/zoom;cx.beginPath();cx.arc(x,y-20/zoom,size/2,0,Math.PI*2);cx.stroke();
 cx.save();cx.font=`${12/zoom}px sans-serif`;cx.textAlign='center';cx.lineWidth=3/zoom;cx.strokeStyle='#203d35';cx.strokeText(name,x,y+20/zoom);cx.fillStyle='#fff';cx.fillText(name,x,y+20/zoom);cx.restore();
 drawSpeechStack(x,y,p.id,p.id===myId||(!p.id&&name.endsWith('（自分）')));
}
function drawMini(){const w=mini.width,h=mini.height;mc.clearRect(0,0,w,h);mc.fillStyle='#aad988';mc.fillRect(0,0,w,h);
 mc.fillStyle='#83c9ed';mc.fillRect(0,0,w,27);mc.fillStyle='#6ba978';mc.fillRect(0,h-27,w,27);
 mc.strokeStyle='#65bee2';mc.lineWidth=6;for(let i=0;i<2;i++){mc.beginPath();for(let j=0;j<=h;j+=3){const y=j/h*H,x=riverX(y,i)/W*w;if(j===0)mc.moveTo(x,j);else mc.lineTo(x,j)}mc.stroke()}
 mc.strokeStyle='#7f8587';mc.lineWidth=6;mc.beginPath();for(let i=0;i<=w;i+=6){const x=i/w*W,y=(2850+55*Math.sin(x*.0009))/H*h;if(i===0)mc.moveTo(i,y);else mc.lineTo(i,y)}mc.stroke();
 for(let h0 of hubs){mc.fillStyle=h0.kind==='dome'?'#568eaf':'#df7e67';mc.beginPath();mc.arc(h0.x/W*w,h0.y/H*h,6,0,Math.PI*2);mc.fill()}
 const px=avatar.x/W*w,py=avatar.y/H*h;mc.fillStyle='#243f48';mc.beginPath();mc.arc(px,py,6,0,Math.PI*2);mc.fill();mc.strokeStyle='#fff';mc.lineWidth=2;mc.stroke();
 mc.strokeStyle='#ffffffd0';mc.lineWidth=2;mc.strokeRect((tx-vw/(2*zoom))/W*w,(ty-vh/(2*zoom))/H*h,vw/zoom/W*w,vh/zoom/H*h)
}
function nearestHub(){return hubs.slice().sort((a,b)=>Math.hypot(a.x-avatar.x,a.y-avatar.y)-Math.hypot(b.x-avatar.x,b.y-avatar.y))[0]}
function toast(s){let e=$('toast');e.textContent=s;e.style.display='block';clearTimeout(toast.timer);toast.timer=setTimeout(()=>e.style.display='none',3300)}
function showModal(title,desc,body){$('modaltitle').textContent=title;$('modaldesc').textContent=desc;$('modalbody').replaceChildren(body);$('modal').classList.add('open')}
$('close').onclick=()=>$('modal').classList.remove('open');$('modal').addEventListener('click',e=>{if(e.target.id==='modal')$('modal').classList.remove('open')});
function board(id,name){openBoard(id)}
function visit(h){if(h.board)board(h.board,h.name);else if(h.kind==='dome'){const e=document.createElement('div');e.textContent='🏟️ 将来のライブ・イベント・みんなの集合拠点！';showModal('水上ドーム','まだ館内マップはありません。',e)}else toast('🏭 水上塗装に到着！')}
function requestPath(x,y){const p=findPath(x,y);if(p.length){route=p;toast('目的地まで道案内を開始したで！')}else toast('そこへは歩いて行けなさそうや。場所を変えてね')}
canvas.addEventListener('pointerdown',e=>{if(e.button!==0)return;let x=tx+(e.clientX-vw/2)/zoom,y=ty+(e.clientY-vh/2)/zoom;
 if(placing){if(blocked(x,y,true)){toast('そこには家を置けないで。草地を選んでね');return}send({type:'home',pos:{x:x/W,y:y/H}});placing=false;toast('🏡 設置を申請したで！');return}
 if(packing){const h=houses.find(v=>v.id===ownerId&&Math.hypot(x-v.x,y-v.y)<130);if(!h){toast('自分の家をクリックしてね');return}send({type:'home',pos:null});packing=false;toast('📦 収納を申請したで！');return}
 const h=hubs.find(v=>Math.hypot(v.x-x,(v.y+55)-y)<190);if(h){visit(h);return}requestPath(x,y)});
mini.addEventListener('pointerdown',e=>{const r=mini.getBoundingClientRect();requestPath((e.clientX-r.left)/r.width*W,(e.clientY-r.top)/r.height*H)});
window.addEventListener('keydown',e=>{if(e.target.matches('textarea,input')||$('modal').classList.contains('open'))return;let k=e.key.toLowerCase();if(['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright'].includes(k)){keys.add(k);e.preventDefault()}});
window.addEventListener('keyup',e=>keys.delete(e.key.toLowerCase()));window.addEventListener('blur',()=>keys.clear());
function go(h){requestPath(h.x,h.y+220)}
$('board1').onclick=()=>go(hubs[0]);$('board2').onclick=()=>go(hubs[2]);$('company').onclick=()=>go(hubs[1]);$('dome').onclick=()=>go(hubs[3]);
$('house').onclick=()=>{placing=!placing;packing=false;toast(placing?'草地をクリックして家を置こう':'設置を中止したで')};
$('pack').onclick=()=>{packing=!packing;placing=false;toast(packing?'しまいたい家をクリックしてね':'収納を中止したで')};
$('plus').onclick=()=>{zoom=Math.min(1.8,Math.round((zoom+.2)*10)/10);$('scale').textContent=zoom.toFixed(1)+'×'};
$('minus').onclick=()=>{zoom=Math.max(.55,Math.round((zoom-.2)*10)/10);$('scale').textContent=zoom.toFixed(1)+'×'};
$('home').onclick=()=>{route=[];tx=avatar.x;ty=avatar.y};

// Online world messages (same map and room for phones and desktop).
function connect(){
 const proto=location.protocol==='https:'?'wss:':'ws:';
 $('network').textContent='接続中…';
 ws=new WebSocket(`${proto}//${location.host}/ws?room=${encodeURIComponent(room)}&owner=${ownerToken}&password=${encodeURIComponent(password)}`);
 ws.addEventListener('open',()=>{connected=true;$('network').textContent='オンライン';send({type:'name',name:profile.name});send({type:'avatar',avatar:profile.avatar})});
 ws.addEventListener('message',ev=>{let d;try{d=JSON.parse(ev.data)}catch{return}
 if(d.type==='welcome'){myId=d.id;peers.clear();for(const p of d.players)peers.set(p.id,p);const p=peers.get(myId);if(p){avatar.x=p.x*W;avatar.y=p.y*H;tx=avatar.x;ty=avatar.y;route=[]}
 houses=Object.entries(d.world?.homes||{}).map(([id,v])=>({id,x:v.x*W,y:v.y*H,name:v.name,color:'#ba7257'}));strokes.splice(0,strokes.length,...(d.world?.strokes||[]));redrawCanvas();}
 if(['join','name','avatar','move'].includes(d.type)){if(d.type==='move'&&d.id===myId)return;const p=peers.get(d.id)||{x:.5,y:.5,name:'参加者',avatar:null};Object.assign(p,d);peers.set(d.id,p)}
 if(d.type==='leave')peers.delete(d.id);
 if(d.type==='chat'){messages.push({id:d.id,text:d.text,until:performance.now()+30000});if(messages.length>100)messages=messages.slice(-100);}
 if(d.type==='home'){houses=houses.filter(h=>h.id!==d.id);if(d.pos)houses.push({id:d.id,x:d.pos.x*W,y:d.pos.y*H,name:d.pos.name,color:'#ba7257'});}
 if(d.type==='home_error')toast(d.message||'家を置けなかったで');
 if(d.type==='fish_result'){const p=peers.get(d.id);toast(`🎣 ${p?.name||'誰か'}が「${d.fish}」を釣り上げた！`);$('fish').disabled=false;$('fish').textContent='🎣 釣り'}
 if(d.type==='draw'){strokes.push(d.stroke);if(strokes.length>1500)strokes.shift();redrawCanvas()}
 if(d.type==='clear_canvas'){strokes.length=0;redrawCanvas()}
 $('people').textContent=`${peers.size}/10人`;
 });
 ws.addEventListener('close',()=>{connected=false;$('network').textContent='切断・再接続中';setTimeout(connect,3000)});
 ws.addEventListener('error',()=>{$('network').textContent='接続できません'});
}
$('name').value=profile.name;
$('name').addEventListener('input',()=>{profile.name=$('name').value.trim().slice(0,16)||'ゲスト';saveProfile();send({type:'name',name:profile.name})});
$('share').addEventListener('click',async()=>{const u=new URL(location.href);u.searchParams.set('room',room);try{await navigator.clipboard.writeText(u.href);toast('招待リンクをコピーしたで！')}catch{prompt('リンクをコピーしてね',u.href)}});
$('chat-form').addEventListener('submit',e=>{e.preventDefault();const t=$('message').value.trim();if(!connected)return toast('接続中だよ');if(!t)return;send({type:'chat',text:t});$('message').value='';});
$('fish').addEventListener('click',()=>{if(!connected)return toast('接続中だよ');$('fish').disabled=true;$('fish').textContent='🎣 ウキがピクピク…';setTimeout(()=>send({type:'fish'}),900);setTimeout(()=>{$('fish').disabled=false;$('fish').textContent='🎣 釣り'},5000)});
$('art').addEventListener('click',()=>{$('art-dialog').hidden=false});$('art-close').addEventListener('click',()=>{$('art-dialog').hidden=true});
const drawCanvas=$('draw-canvas'),dc=drawCanvas.getContext('2d');let drawColor='#e24b45',drawing=false,lastPoint=null;
function drawStroke(s){if(!s||!s.points)return;const p=s.points;dc.strokeStyle=s.color;dc.lineWidth=4;dc.lineCap='round';dc.beginPath();dc.moveTo(p[0]*drawCanvas.width,p[1]*drawCanvas.height);dc.lineTo(p[2]*drawCanvas.width,p[3]*drawCanvas.height);dc.stroke()}
function redrawCanvas(){dc.fillStyle='#fffefa';dc.fillRect(0,0,drawCanvas.width,drawCanvas.height);strokes.forEach(drawStroke)}redrawCanvas();
document.querySelectorAll('.art-color').forEach(b=>b.addEventListener('click',()=>{drawColor=b.dataset.color;document.querySelectorAll('.art-color').forEach(x=>x.classList.toggle('selected',x===b))}));
$('art-clear').onclick=()=>{if(confirm('みんなの絵を消しますか？'))send({type:'clear_canvas'})};
function drawPoint(e){const r=drawCanvas.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))}}
drawCanvas.addEventListener('pointerdown',e=>{if(!connected)return;e.preventDefault();drawing=true;lastPoint=drawPoint(e);drawCanvas.setPointerCapture(e.pointerId)});
drawCanvas.addEventListener('pointermove',e=>{if(!drawing)return;const p=drawPoint(e);const s={points:[lastPoint.x,lastPoint.y,p.x,p.y],color:drawColor};drawStroke(s);send({type:'draw',points:s.points,color:drawColor});lastPoint=p});
['pointerup','pointercancel','lostpointercapture'].forEach(v=>drawCanvas.addEventListener(v,()=>drawing=false));
  const preview = $('crop-preview'), cropCtx = preview.getContext('2d');
  let source = null, photoZoom = 1, offsetX = 0, offsetY = 0, drag = null, sourceUrl = null;
  function paint(){
    if(!source) return; const w=preview.width,h=preview.height;
    cropCtx.clearRect(0,0,w,h); cropCtx.fillStyle='#132a33'; cropCtx.fillRect(0,0,w,h);
    const scale=Math.max(w/source.naturalWidth,h/source.naturalHeight)*photoZoom;
    const sw=source.naturalWidth*scale,sh=source.naturalHeight*scale;
    offsetX=Math.max(-Math.max(0,(sw-w)/2),Math.min(Math.max(0,(sw-w)/2),offsetX));
    offsetY=Math.max(-Math.max(0,(sh-h)/2),Math.min(Math.max(0,(sh-h)/2),offsetY));
    cropCtx.drawImage(source,(w-sw)/2+offsetX,(h-sh)/2+offsetY,sw,sh);
    cropCtx.strokeStyle='rgba(255,255,255,.95)'; cropCtx.lineWidth=3; cropCtx.beginPath(); cropCtx.arc(w/2,h/2,w/2-3,0,Math.PI*2); cropCtx.stroke();
  }
  $('avatar-file').addEventListener('change',e=>{
    const file=e.target.files?.[0]; if(!file)return;
    if(!['image/jpeg','image/png'].includes(file.type)){alert('JPEGまたはPNGを選んでね。'); e.target.value=''; return;}
    if(file.size>12*1024*1024){alert('画像は12MB以下にしてね。'); e.target.value=''; return;}
    if(sourceUrl)URL.revokeObjectURL(sourceUrl);
    sourceUrl=URL.createObjectURL(file); const img=new Image();
    img.onload=()=>{ source=img; photoZoom=1; offsetX=0; offsetY=0; $('zoom').value='1'; $('crop-dialog').hidden=false; paint(); };
    img.onerror=()=>{ alert('画像を読み込めませんでした。'); URL.revokeObjectURL(sourceUrl); };
    img.src=sourceUrl; e.target.value='';
  });
  $('zoom').addEventListener('input',e=>{ photoZoom=Number(e.target.value); paint(); });
  preview.addEventListener('pointerdown',e=>{ e.preventDefault(); drag={id:e.pointerId,x:e.clientX,y:e.clientY}; preview.setPointerCapture(e.pointerId); });
  preview.addEventListener('pointermove',e=>{
    if(!drag||drag.id!==e.pointerId)return;
    const rect=preview.getBoundingClientRect();
    offsetX+=(e.clientX-drag.x)*(preview.width/rect.width); offsetY+=(e.clientY-drag.y)*(preview.height/rect.height);
    drag.x=e.clientX; drag.y=e.clientY; paint();
  });
  ['pointerup','pointercancel','lostpointercapture'].forEach(type=>preview.addEventListener(type,()=>{ drag=null; }));
  $('crop-cancel').addEventListener('click',()=>{ $('crop-dialog').hidden=true; });
  $('crop-save').addEventListener('click',()=>{
    if(!source)return;
    const output=document.createElement('canvas'); output.width=128; output.height=128;
    const c=output.getContext('2d'); c.drawImage(preview,0,0,128,128);
    let encoded=output.toDataURL('image/jpeg',.78);
    if(encoded.length>33000)encoded=output.toDataURL('image/jpeg',.55);
    if(encoded.length>33000){alert('画像を軽量化できませんでした。別の画像を試してね。');return;}
    profile.avatar=encoded; saveProfile(); send({type:'avatar',avatar:encoded});
    $('crop-dialog').hidden=true;
  });
  $('avatar-remove').addEventListener('click',()=>{
    profile.avatar=null; saveProfile(); send({type:'avatar',avatar:null});
  });

  // v1.9 Two city bulletin boards. Boards are global to all rooms.
  const boardLabels={saijo:'西条市役所',niihama:'新居浜市役所'};
  const boardDialog=$('board-dialog');
  const boardPosts=$('board-posts');
  const boardComment=$('board-comment');
  const boardFiles=$('board-files');
  let activeBoard=null, boardFilesSelected=[], boardNextBefore=null, boardLoaded=[];
  const boardToken=ownerToken;
  const boardOwnedKey='mizukami-board-own-posts-v1';
  let boardOwned=[];try{boardOwned=JSON.parse(localStorage.getItem(boardOwnedKey)||'[]');if(!Array.isArray(boardOwned))boardOwned=[];}catch{boardOwned=[];}
  function rememberOwnPost(id){boardOwned=[id,...boardOwned.filter(existing=>existing!==id)].slice(0,500);try{localStorage.setItem(boardOwnedKey,JSON.stringify(boardOwned));}catch{}}
  const boardStatus=(message,error=false)=>{$('board-status').textContent=message;$('board-status').style.color=error?'#b04b42':'#287a58';};
  const stamp=at=>new Date(at).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
  const boardLink=post=>`${location.origin}/?board=${encodeURIComponent(post.board)}&post=${encodeURIComponent(post.id)}`;
  function canPostAtHall(board){
    const hall=hubs.find(h=>h.board===board);
    return !!hall && Math.hypot(avatar.x-hall.x,avatar.y-(hall.y+55))<=380;
  }
  function updateBoardPermission(){
    if(!activeBoard)return;
    const canPost=canPostAtHall(activeBoard);
    $('board-form').hidden=!canPost;
    $('board-form').style.display=canPost?'':'none';
    $('board-help').textContent=canPost
      ?'市役所に到着！140文字と画像3枚まで投稿できるで。投稿は全ルーム共通。'
      :'📖 閲覧モード：どこからでも読めるで！書き込みはこの市役所の前でできるよ。';
  }
  async function openBoard(board){
    if(!boardLabels[board])return;
    activeBoard=board;boardDialog.hidden=false;
    $('board-title').textContent=`📌 ${boardLabels[board]} 掲示板`;
    boardComment.value='';boardFiles.value='';boardFilesSelected=[];previewBoardFiles();boardStatus('');
    updateBoardPermission();
    await refreshBoard();
  }
  function closeBoard(){boardDialog.hidden=true;activeBoard=null;}
  document.querySelectorAll('[data-board]').forEach(button=>button.addEventListener('click',()=>openBoard(button.dataset.board)));
  $('board-read-saijo').addEventListener('click',()=>openBoard('saijo'));
  $('board-read-niihama').addEventListener('click',()=>openBoard('niihama'));
  $('board-close').addEventListener('click',closeBoard);
  boardDialog.addEventListener('pointerdown',e=>{if(e.target===boardDialog)closeBoard();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!boardDialog.hidden)closeBoard();});
  boardComment.addEventListener('input',()=>{$('board-counter').textContent=`${Array.from(boardComment.value).length} / 140文字`;});
  function previewBoardFiles(){
    const wrap=$('board-preview');wrap.replaceChildren();
    for(const f of boardFilesSelected){const img=document.createElement('img');img.src=f.url;img.alt='添付予定';wrap.append(img);}
  }
  boardFiles.addEventListener('change',async()=>{
    const inputs=[...boardFiles.files];
    for(const f of boardFilesSelected)URL.revokeObjectURL(f.url);
    boardFilesSelected=[];
    if(inputs.length>3){boardStatus('画像は最大3枚までやで。',true);boardFiles.value='';return;}
    for(const f of inputs){
      if(!['image/jpeg','image/png','image/webp'].includes(f.type)||f.size>5*1024*1024){
        boardStatus('画像はJPEG/PNG/WebP、1枚5MB以下でお願い！',true);boardFiles.value='';return;
      }
      boardFilesSelected.push({file:f,url:URL.createObjectURL(f)});
    }
    previewBoardFiles();boardStatus('');
  });
  async function compressBoardImage(file){
    const src=URL.createObjectURL(file);
    try{
      const img=await new Promise((res,rej)=>{const image=new Image();image.onload=()=>res(image);image.onerror=()=>rej(new Error('画像を読み込めないよ'));image.src=src;});
      if(img.naturalWidth*img.naturalHeight>20_000_000)throw new Error('画像の解像度が大きすぎるよ');
      const maxSide=1280,scale=Math.min(1,maxSide/Math.max(img.naturalWidth,img.naturalHeight));
      const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
      const c=canvas.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,canvas.width,canvas.height);c.drawImage(img,0,0,canvas.width,canvas.height);
      for(const quality of [.75,.6,.45]){
        const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));
        if(blob&&blob.size<=230000){const buffer=await blob.arrayBuffer();const bytes=new Uint8Array(buffer);let binary='';for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(binary);}
      }
      throw new Error('画像を軽くできなかったよ。別の画像を試してね');
    }finally{URL.revokeObjectURL(src);}
  }
  async function apiBoard(path, options={}){
    const response=await fetch(path,{cache:'no-store',...options});
    if(!response.ok){let message;try{message=await response.text();}catch{};throw new Error(message||`通信エラー ${response.status}`);}
    return response.json();
  }
  async function refreshBoard(before=null){
    const board=activeBoard;if(!board)return;
    boardStatus('読み込み中…');
    try{
      const url=`/api/boards/${board}/posts${before?`?before=${before}`:''}`;
      const {posts}=await apiBoard(url);
      if(activeBoard!==board)return;
      boardLoaded=before?boardLoaded.concat(posts):posts;
      boardNextBefore=posts.length===30?posts.at(-1).created_at:null;
      $('board-more').hidden=!boardNextBefore;
      renderBoardPosts();boardStatus('');
    }catch(error){boardStatus('読み込めなかったよ：'+error.message,true);}
  }
  $('board-refresh').addEventListener('click',()=>refreshBoard());
  $('board-more').addEventListener('click',()=>{if(boardNextBefore)refreshBoard(boardNextBefore);});
  $('board-form').addEventListener('submit',async e=>{
    e.preventDefault();if(!activeBoard)return;
    if(!canPostAtHall(activeBoard)){
      updateBoardPermission();
      return boardStatus('書き込みは市役所の前でお願いね。',true);
    }
    const text=boardComment.value.trim();
    if(Array.from(text).length>140||(!text&&!boardFilesSelected.length))return boardStatus('コメント140文字以内、または画像を選んでね。',true);
    const button=$('board-submit');button.disabled=true;boardStatus('画像の軽量化・投稿中…');
    try{
      const images=[];for(const selection of boardFilesSelected)images.push(await compressBoardImage(selection.file));
      const board=activeBoard;
      const created=await apiBoard(`/api/boards/${board}/posts`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({author:profile.name,text,images,token:boardToken})});
      rememberOwnPost(created.post.id);
      boardComment.value='';$('board-counter').textContent='0 / 140文字';
      boardFiles.value='';for(const selection of boardFilesSelected)URL.revokeObjectURL(selection.url);boardFilesSelected=[];previewBoardFiles();
      await refreshBoard();boardStatus('投稿できたで！');
    }catch(error){boardStatus(error.message,true);}finally{button.disabled=false;}
  });
  function shareX(post){
    // X counts URLs separately; keep the 140-character post text intact and let the user attach a link when space permits.
    const url='https://twitter.com/intent/tweet?text='+encodeURIComponent(post.text);
    window.open(url,'_blank','noopener,noreferrer');
  }
  function shareLine(post){
    const shareText=[post.text,boardLink(post)].filter(Boolean).join('\n');
    window.open('https://line.me/R/msg/text/?'+encodeURIComponent(shareText),'_blank','noopener,noreferrer');
  }
  async function createInstagramCard(post){
    const card=document.createElement('canvas');card.width=1080;card.height=1350;
    const c=card.getContext('2d');
    c.fillStyle='#f5eddd';c.fillRect(0,0,1080,1350);
    c.fillStyle='#2c715b';c.fillRect(0,0,1080,130);c.fillStyle='#fff';c.font='bold 54px sans-serif';c.fillText('水上base',64,86);
    c.fillStyle='#355c4e';c.font='bold 44px sans-serif';c.fillText(boardLabels[post.board]+' 掲示板',65,216);
    let top=275;
    if(post.images.length){
      const image=await new Promise((resolve,reject)=>{const el=new Image();el.onload=()=>resolve(el);el.onerror=reject;el.src=post.images[0];});
      const area={x:65,y:260,w:950,h:610};
      const scale=Math.max(area.w/image.width,area.h/image.height);
      const sw=area.w/scale,sh=area.h/scale;
      c.save();c.beginPath();c.rect(area.x,area.y,area.w,area.h);c.clip();c.drawImage(image,(image.width-sw)/2,(image.height-sh)/2,sw,sh,area.x,area.y,area.w,area.h);c.restore();
      top=930;
    }
    const fontSize=post.images.length?39:49; c.font=`${fontSize}px sans-serif`;c.fillStyle='#293c32';
    const maxW=940,lineHeight=fontSize*1.55;let line='',y=top;
    for(const char of post.text){
      if(char==='\n'){c.fillText(line,70,y);y+=lineHeight;line='';continue;}
      if(c.measureText(line+char).width>maxW){c.fillText(line,70,y);y+=lineHeight;line='';}
      if(y>1180)break;line+=char;
    }
    if(line&&y<=1180)c.fillText(line,70,y);
    c.fillStyle='#6d8175';c.font='31px sans-serif';c.fillText(`投稿：${post.author}　${stamp(post.created_at)}`,68,1285);
    return await new Promise((resolve,reject)=>card.toBlob(blob=>blob?resolve(blob):reject(new Error('画像の作成に失敗')),'image/png'));
  }
  async function shareInstagram(post){
    try{
      const blob=await createInstagramCard(post);
      const filename=`mizukami-board-${post.id}.png`;
      const file=new File([blob],filename,{type:'image/png'});
      if(navigator.canShare&&navigator.canShare({files:[file]})&&navigator.share){
        try{await navigator.share({files:[file],title:'水上base 掲示板'});return;}catch(error){if(error.name==='AbortError')return;}
      }
      const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),6000);
      await navigator.clipboard?.writeText(post.text).catch(()=>{});
      boardStatus('Instagram用画像を保存したで！Instagramで画像を選んで、本文を貼り付けてね。');
    }catch(error){boardStatus('共有画像の作成に失敗：'+error.message,true);}
  }
  function appendBoardAction(parent,label,callback,extra=''){
    const button=make('button',extra,label);button.type='button';button.addEventListener('click',callback);parent.append(button);return button;
  }
  function renderBoardPosts(){
    boardPosts.replaceChildren();
    if(!boardLoaded.length){boardPosts.append(make('p','board-help','まだ書き込みがないで！最初の一言をどうぞ。'));return;}
    for(const post of boardLoaded){
      const article=make('article','board-post');
      if(params.get('post')===post.id)article.style.outline='3px solid #78c9a2';
      const meta=make('div','board-post-meta');meta.append(make('b','',post.author),make('span','',stamp(post.created_at)));
      article.append(meta,make('p','board-post-body',post.text));
      if(post.images.length){
        const imgs=make('div','board-post-images');
        for(const url of post.images){const a=document.createElement('a');a.href=url;a.target='_blank';a.rel='noopener noreferrer';const img=document.createElement('img');img.src=url;img.alt='投稿の添付画像';img.loading='lazy';a.append(img);imgs.append(a);}
        article.append(imgs);
      }
      const actions=make('div','board-post-actions');
      appendBoardAction(actions,'X',()=>shareX(post));
      appendBoardAction(actions,'LINE',()=>shareLine(post));
      appendBoardAction(actions,'Instagram画像',()=>shareInstagram(post));
      appendBoardAction(actions,'文章をコピー',async()=>{try{await navigator.clipboard.writeText(post.text);boardStatus('文章をコピーしたで！');}catch{boardStatus('コピーできませんでした。',true);}});
      appendBoardAction(actions,'投稿リンク',async()=>{try{await navigator.clipboard.writeText(boardLink(post));boardStatus('投稿リンクをコピーしたで！');}catch{boardStatus('リンクをコピーできませんでした。',true);}});
      if(boardOwned.includes(post.id)){appendBoardAction(actions,'自分の投稿を削除',async()=>{
        if(!confirm('この投稿を削除していい？'))return;
        try{await apiBoard(`/api/boards/${post.board}/posts/${post.id}`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:boardToken})});await refreshBoard();boardStatus('削除したで。');}
        catch(e){boardStatus('削除できなかったよ：'+e.message,true);}
      },'delete');}
      article.append(actions);boardPosts.append(article);
    }
  }
  if(boardLabels[params.get('board')])openBoard(params.get('board'));


function tick(now){const dt=Math.min((now-last)/1000,.07);last=now;
 let dx=(keys.has('d')||keys.has('arrowright')?1:0)-(keys.has('a')||keys.has('arrowleft')?1:0);
 let dy=(keys.has('s')||keys.has('arrowdown')?1:0)-(keys.has('w')||keys.has('arrowup')?1:0);
 if(dx||dy)route=[];else if(route.length){dx=route[0].x-avatar.x;dy=route[0].y-avatar.y;if(Math.hypot(dx,dy)<10){route.shift();dx=0;dy=0}}
 const n=Math.hypot(dx,dy);if(n){const step=Math.min(SPEED*dt,n),nx=avatar.x+dx/n*step,ny=avatar.y+dy/n*step;
 if(!blocked(nx,ny)){avatar.x=nx;avatar.y=ny;if(connected&&now-sendAt>65){send({type:'move',x:avatar.x/W,y:avatar.y/H});sendAt=now}}else if(route.length){route=[]}}
 tx+=(avatar.x-tx)*Math.min(1,dt*9);ty+=(avatar.y-ty)*Math.min(1,dt*9);
 draw();requestAnimationFrame(tick)}
connect();requestAnimationFrame(tick);toast('🌳 オンライン西条・新居浜ワールドへようこそ！')
})();