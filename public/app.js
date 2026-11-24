(() => {
  'use strict';
  const params = new URLSearchParams(location.search);
  let room = params.get('room');
  if (!room || !/^[\w-]{1,32}$/.test(room)) {
    room = Math.random().toString(36).slice(2, 10);
    params.set('room', room);
    history.replaceState(null, '', location.pathname + '?' + params.toString());
  }
  const password = params.get('password') || '';
  const $ = id => document.getElementById(id);
  const storageKey = 'mizukami-base-profile-v1';
  let ownerToken = localStorage.getItem('mizukami-base-house-owner');
  if(!ownerToken || !/^[a-f0-9]{32}$/.test(ownerToken)) {
    ownerToken=Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
    try{localStorage.setItem('mizukami-base-house-owner',ownerToken);}catch(_){}
  }
  const ownerId='owner-'+ownerToken;
  let profile = {name:'ゲスト',avatar:null};
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
    if (typeof saved.name === 'string') profile.name = saved.name.slice(0,16) || 'ゲスト';
    if (typeof saved.avatar === 'string' && /^data:image\/jpeg;base64,/.test(saved.avatar) && saved.avatar.length < 33000) profile.avatar = saved.avatar;
  } catch (_) {}
  function saveProfile() {
    try { localStorage.setItem(storageKey, JSON.stringify(profile)); }
    catch (_) {}
  }
  $('name').value = profile.name;
  $('room').textContent = room;
  const players = new Map();
  let myId = null, ws = null, active = new Set(), connected = false;
  const make = (tag, className, text) => { const el = document.createElement(tag); el.className = className; if (text != null) el.textContent = text; return el; };
  const status = (label, online) => { $('status').textContent = label; $('status').className = 'status ' + (online ? 'online' : 'offline'); };

  // World geometry is an intentionally coarse collision prototype drawn against
  // the approved 2.5D concept image, not surveyed geographic data.
  function inWaterOrMountain(x,y){
    if(x<.025 || x>.975 || y<.245 || y>.81)return true;
    const river1=.36+.012*Math.sin(15*y);
    const river2=.685+.016*Math.sin(17*y);
    const onBridge=Math.abs(y-.475)<.023 || Math.abs(y-.578)<.020;
    if(!onBridge && (Math.abs(x-river1)<.014 || Math.abs(x-river2)<.015))return true;
    return false;
  }
  const landmarkBlocks=[
    [.22,.29,.19,.27], [.32,.39,.30,.37], [.55,.64,.22,.32],
    [.69,.78,.29,.38], [.78,.87,.34,.43], [.17,.29,.48,.57],
    [.76,.88,.49,.57], [.23,.32,.64,.75], [.76,.86,.64,.75]
  ];
  function isBlocked(x,y,ignoreLandmarks=false){
    if(inWaterOrMountain(x,y))return true;
    if(!ignoreLandmarks && landmarkBlocks.some(([l,r,t,b])=>x>=l&&x<=r&&y>=t&&y<=b))return true;
    if(!ignoreLandmarks && typeof homes !== 'undefined' && [...homes.values()].some(el=>Math.hypot(Number(el.dataset.x)-x,Number(el.dataset.y)-y)<.032))return true;
    return false;
  }
  function homeAllowed(x,y){
    if(isBlocked(x,y))return false;
    if(y<.29||y>.755)return false;
    // Keep the main gravel road and the railway clear for everyone.
    if(Math.abs(y-.473)<.031 || Math.abs(y-.58)<.030)return false;
    if([...homes.values()].some(el=>Math.hypot(Number(el.dataset.x)-x,Number(el.dataset.y)-y)<.085))return false;
    if([...players.values()].some(p=>Math.hypot(p.x-x,p.y-y)<.055))return false;
    return true;
  }
  function setMapMessage(text) {
    const note = $('map-note');
    if (!note) return;
    note.textContent = text;
    clearTimeout(setMapMessage.timer);
    setMapMessage.timer = setTimeout(() => {
      note.textContent = '西条・新居浜マップβ：海・山・川は歩けません。道や草地をクリックして探索できます。';
    }, 5300);
  }
  const mapWorld=$('map-world'),field=$('field');
  let mapZoom=1.8, overviewMode=false;
  const mapZoomOptions=[1,1.4,1.8,2.4,3.2];
  function placeCamera(){
    let x=.52,y=.53;
    if(myId && players.has(myId)){ const p=players.get(myId);x=p.x;y=p.y; }
    const w=field.clientWidth,h=field.clientHeight;
    const tx=Math.max(w*(1-mapZoom),Math.min(0,w*.5-w*x*mapZoom));
    const ty=Math.max(h*(1-mapZoom),Math.min(0,h*.5-h*y*mapZoom));
    mapWorld.style.transform=`translate(${tx}px,${ty}px) scale(${mapZoom})`;
    mapWorld.style.setProperty('--invzoom',String(1/mapZoom));
    $('zoom-label').textContent=mapZoom.toFixed(1)+'×';
  }
  function changeZoom(delta){
    let i=mapZoomOptions.indexOf(mapZoom);
    if(i<0)i=2;
    mapZoom=mapZoomOptions[Math.max(0,Math.min(mapZoomOptions.length-1,i+delta))];
    overviewMode=mapZoom===1;placeCamera();
  }
  $('zoom-in').addEventListener('click',()=>changeZoom(1));
  $('zoom-out').addEventListener('click',()=>changeZoom(-1));
  $('overview').addEventListener('click',()=>{mapZoom=mapZoom===1?1.8:1;overviewMode=mapZoom===1;placeCamera();});
  window.addEventListener('resize',placeCamera);
  const gridSize=65;
  const gridKey=(x,y)=>y*gridSize+x;
  const gridPt=(x,y)=>({x:(x+.5)/gridSize,y:(y+.5)/gridSize});
  function walkableGrid(x,y){const p=gridPt(x,y);return !isBlocked(p.x,p.y);}
  function snapGrid(x,y){
    let best=null,dist=Infinity;
    for(let r=0;r<gridSize;r++)for(let c=0;c<gridSize;c++){
      if(!walkableGrid(c,r))continue;
      const t=gridPt(c,r),d=(x-t.x)**2+(y-t.y)**2;
      if(d<dist){best={c,r};dist=d;}
    }
    return best;
  }
  function routeTo(x,y){
    if(!myId || !players.has(myId))return [];
    const me=players.get(myId),start=snapGrid(me.x,me.y),end=snapGrid(x,y);
    if(!start || !end)return [];
    const a=gridKey(start.c,start.r),b=gridKey(end.c,end.r);
    const q=[a],parent=new Map([[a,-1]]);
    for(let head=0;head<q.length;head++){
      const id=q[head];if(id===b)break;
      const c=id%gridSize,r=Math.floor(id/gridSize);
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
        const nc=c+dx,nr=r+dy;
        if(nc<0||nr<0||nc>=gridSize||nr>=gridSize||!walkableGrid(nc,nr))continue;
        const nid=gridKey(nc,nr);if(parent.has(nid))continue;
        parent.set(nid,id);q.push(nid);
      }
    }
    if(!parent.has(b)){setMapMessage('そこへは道がつながっていないみたいや。別の場所を選んでね。');return [];}
    const ids=[];for(let k=b;k!==-1;k=parent.get(k))ids.push(k);
    ids.reverse();return ids.slice(1).map(id=>gridPt(id%gridSize,Math.floor(id/gridSize)));
  }

  function render() {
    $('count').textContent = `${players.size} / 10 人`;
    $('empty').hidden = players.size > 1;
    for (const [id, p] of players) {
      if (!p.el) {
        p.el = make('div','character'); p.dot = make('div','dot');
        p.rig = make('div','avatar-rig');
        for (const side of ['left','right']) {
          p.rig.append(make('span',`limb arm ${side}`),make('span',`limb leg ${side}`));
        }
        p.rig.append(p.dot);
        p.img = document.createElement('img'); p.img.alt=''; p.img.hidden=true; p.dot.append(p.img);
        p.tag = make('div','tag'); p.bubbles = make('div','bubbles');
        p.el.append(p.bubbles,p.rig,p.tag); $('characters').append(p.el);
      }
      p.el.className = 'character ' + (id === myId ? 'mine' : 'other') + ((p.movingUntil || 0) > performance.now() ? ' moving' : '');
      p.el.style.left = (p.x * 100) + '%'; p.el.style.top = (p.y * 100) + '%';
      p.tag.textContent = id === myId ? `${p.name}（自分）` : p.name;
      if (p.lastAvatar !== p.avatar) {
        p.lastAvatar = p.avatar;
        if (p.avatar) { p.img.src = p.avatar; p.img.hidden = false; p.dot.classList.add('has-photo'); }
        else { p.img.removeAttribute('src'); p.img.hidden = true; p.dot.classList.remove('has-photo'); }
      }
    }
    placeCamera();
  }
  function updatePlayer(data) {
    const p = players.get(data.id) || {x:.5,y:.5,name:'参加者',avatar:null};
    if (data.type === 'move' && data.id !== myId && typeof data.x === 'number' && typeof data.y === 'number' && Math.hypot(data.x-p.x,data.y-p.y) > .0001) p.movingUntil = performance.now()+210;
    if (typeof data.x === 'number') p.x = data.x;
    if (typeof data.y === 'number') p.y = data.y;
    if (typeof data.name === 'string') p.name = data.name;
    if (Object.prototype.hasOwnProperty.call(data,'avatar')) p.avatar = data.avatar;
    players.set(data.id,p); render();
  }
  function talk(data) {
    const p = players.get(data.id); if (!p) return;
    const bubble = make('div','bubble',data.text); p.bubbles.append(bubble);
    while (p.bubbles.children.length > 6) p.bubbles.firstChild.remove();
    setTimeout(() => bubble.remove(), 30000);
  }
  function send(data){ if(ws && ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(data)); }

  function connect(){
    status('接続中…',false);
    const proto = location.protocol==='https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws?room=${encodeURIComponent(room)}&password=${encodeURIComponent(password)}&owner=${ownerToken}`);
    ws.addEventListener('open',()=>{ connected = true; status('オンライン',true); });
    ws.addEventListener('message',event=>{
      let data; try{ data = JSON.parse(event.data); } catch { return; }
      if(data.type==='welcome'){
        myId = data.id; players.clear(); $('characters').replaceChildren(); data.players.forEach(updatePlayer);
        homes.clear(); Object.entries(data.world?.homes || {}).forEach(([id,pos])=>updateHome(id,pos));
        strokes.length=0; (data.world?.strokes || []).forEach(stroke=>strokes.push(stroke)); redrawCanvas();
        send({type:'name',name:profile.name}); send({type:'avatar',avatar:profile.avatar});
      }
      if (['join','move','name','avatar'].includes(data.type)) {
        if (data.type === 'move' && data.id === myId) return;
        updatePlayer(data);
      }
      if(data.type==='leave'){ const p = players.get(data.id); p?.el?.remove(); players.delete(data.id); render(); }
      if(data.type==='chat') talk(data);
      if(data.type==='home') updateHome(data.id,data.pos);
      if(data.type==='home_error') setMapMessage(data.message || 'ここには家を置けません。');
      if(data.type==='draw') addStroke(data.stroke);
      if(data.type==='clear_canvas') {strokes.length=0; redrawCanvas();}
      if(data.type==='fish_result') showCatch(data);

    });
    ws.addEventListener('close',()=>{ connected=false; status('オフライン / 入室上限の可能性あり',false); players.clear(); $('characters').replaceChildren(); render(); });
    ws.addEventListener('error',()=>status('接続できません',false));
  }

  $('name').addEventListener('input',()=>{
    profile.name = $('name').value.trim().slice(0,16) || 'ゲスト';
    saveProfile(); send({type:'name',name:profile.name});
  });
  $('share').addEventListener('click', async()=>{
    try { await navigator.clipboard.writeText(location.href); $('share').textContent='コピーしました ✓'; setTimeout(()=>$('share').textContent='招待URLをコピー',2000); }
    catch { prompt('このURLを共有してください',location.href); }
  });
  $('chat-form').addEventListener('submit',e=>{ e.preventDefault(); const input=$('message'); const value=input.value.trim(); if(!value||!connected)return; send({type:'chat',text:value}); input.value=''; });

  document.querySelectorAll('.poi').forEach(button => {
    button.addEventListener('click', e => {
      e.preventDefault();
      const name = button.dataset.poiName || button.textContent.trim();
      setMapMessage(`${name}：将来ここから専用ルームへ移動できる予定です。`);
    });
  });

  const keys = {arrowup:[0,-1],w:[0,-1],arrowdown:[0,1],s:[0,1],arrowleft:[-1,0],a:[-1,0],arrowright:[1,0],d:[1,0]};
  document.addEventListener('keydown',e=>{ if(e.target.matches('input,textarea,button') || !$('crop-dialog').hidden) return; const key=e.key.toLowerCase(); if(keys[key]){ active.add(key); e.preventDefault(); } });
  document.addEventListener('keyup',e=>active.delete(e.key.toLowerCase())); window.addEventListener('blur',()=>active.clear());
  document.querySelectorAll('[data-dx]').forEach(button=>{
    const key=`pad-${button.dataset.dx}-${button.dataset.dy}`; keys[key] = [Number(button.dataset.dx), Number(button.dataset.dy)];
    button.addEventListener('pointerdown',e=>{ e.preventDefault(); active.add(key); button.setPointerCapture(e.pointerId); });
    ['pointerup','pointercancel','lostpointercapture'].forEach(event=>button.addEventListener(event,()=>active.delete(key)));
  });

  let walkRoute=[],placingHome=false;
  function endPlacement(){placingHome=false;field.classList.remove('placing-home');$('home-button').textContent='🏡 家を置く／引っ越す';}
  field.addEventListener('pointerdown',e=>{
    if(e.button!==0 || !connected || !myId)return;
    if(e.target.closest('button, input, .character'))return;
    const b=mapWorld.getBoundingClientRect();
    const x=Math.max(0,Math.min(1,(e.clientX-b.left)/b.width));
    const y=Math.max(0,Math.min(1,(e.clientY-b.top)/b.height));
    if(placingHome){
      if(!homeAllowed(x,y))return setMapMessage('ここには建てられないで！海・山・線路・道路・施設は避けてね。');
      send({type:'home',pos:{x,y}});
      // The server confirms placement before showing it to all players.
      endPlacement();setMapMessage('ログハウスを設置中…');
    }else{
      if(isBlocked(x,y))setMapMessage('そこは通れない場所。近くの歩ける場所まで向かうで！');
      walkRoute=routeTo(x,y);
    }
  });
  let last=performance.now();
  setInterval(()=>{
    const now=performance.now(),dt=Math.min((now-last)/1000,.1);last=now;
    if(!connected || !myId || !players.has(myId))return;
    const p=players.get(myId),speed=.22;
    let dx=0,dy=0;
    if(active.size){
      walkRoute=[];
      for(const key of active){const v=keys[key];if(v){dx+=v[0];dy+=v[1];}}
    }else if(walkRoute.length){
      let guard=0;
      while(walkRoute.length && Math.hypot(walkRoute[0].x-p.x,walkRoute[0].y-p.y)<.009 && guard++<8)walkRoute.shift();
      if(!walkRoute.length)return;
      dx=walkRoute[0].x-p.x;dy=walkRoute[0].y-p.y;
    }else return;
    const d=Math.hypot(dx,dy);if(!d)return;
    const step=Math.min(speed*dt,d);
    const nx=p.x+dx/d*step,ny=p.y+dy/d*step;
    if(!isBlocked(nx,ny)){p.x=nx;p.y=ny;}
    else if(!walkRoute.length){
      if(!isBlocked(nx,p.y))p.x=nx;
      else if(!isBlocked(p.x,ny))p.y=ny;
      else return;
    }else{walkRoute=[];setMapMessage('ここは通れないみたい。別の道を選んでね。');return;}
    p.movingUntil=now+145;render();send({type:'move',x:p.x,y:p.y});
  },50);

  setInterval(() => {
    const t = performance.now();
    for (const p of players.values()) {
      if (p.el && p.el.classList.contains('moving') && (p.movingUntil || 0) <= t) p.el.classList.remove('moving');
    }
  },100);

  const preview = $('crop-preview'), ctx = preview.getContext('2d');
  let source = null, zoom = 1, offsetX = 0, offsetY = 0, drag = null, sourceUrl = null;
  function paint(){
    if(!source) return; const w=preview.width,h=preview.height;
    ctx.clearRect(0,0,w,h); ctx.fillStyle='#132a33'; ctx.fillRect(0,0,w,h);
    const scale=Math.max(w/source.naturalWidth,h/source.naturalHeight)*zoom;
    const sw=source.naturalWidth*scale,sh=source.naturalHeight*scale;
    offsetX=Math.max(-Math.max(0,(sw-w)/2),Math.min(Math.max(0,(sw-w)/2),offsetX));
    offsetY=Math.max(-Math.max(0,(sh-h)/2),Math.min(Math.max(0,(sh-h)/2),offsetY));
    ctx.drawImage(source,(w-sw)/2+offsetX,(h-sh)/2+offsetY,sw,sh);
    ctx.strokeStyle='rgba(255,255,255,.95)'; ctx.lineWidth=3; ctx.beginPath(); ctx.arc(w/2,h/2,w/2-3,0,Math.PI*2); ctx.stroke();
  }
  $('avatar-file').addEventListener('change',e=>{
    const file=e.target.files?.[0]; if(!file)return;
    if(!['image/jpeg','image/png'].includes(file.type)){alert('JPEGまたはPNGを選んでね。'); e.target.value=''; return;}
    if(file.size>12*1024*1024){alert('画像は12MB以下にしてね。'); e.target.value=''; return;}
    if(sourceUrl)URL.revokeObjectURL(sourceUrl);
    sourceUrl=URL.createObjectURL(file); const img=new Image();
    img.onload=()=>{ source=img; zoom=1; offsetX=0; offsetY=0; $('zoom').value='1'; $('crop-dialog').hidden=false; paint(); };
    img.onerror=()=>{ alert('画像を読み込めませんでした。'); URL.revokeObjectURL(sourceUrl); };
    img.src=sourceUrl; e.target.value='';
  });
  $('zoom').addEventListener('input',e=>{ zoom=Number(e.target.value); paint(); });
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
    profile.avatar=encoded; saveProfile(); displayOwnAvatar(); send({type:'avatar',avatar:encoded});
    if(myId)updatePlayer({id:myId,avatar:encoded});
    $('crop-dialog').hidden=true;
  });
  $('avatar-remove').addEventListener('click',()=>{
    profile.avatar=null; saveProfile(); displayOwnAvatar(); send({type:'avatar',avatar:null});
    if(myId)updatePlayer({id:myId,avatar:null});
  });
  function displayOwnAvatar(){
    const image=$('profile-photo'); image.hidden=!profile.avatar;
    if(profile.avatar) image.src=profile.avatar; else image.removeAttribute('src');
    $('profile-placeholder').hidden=!!profile.avatar;
  }

  // Mini activities: server-selected fishing result, portable cabins and shared artwork.
  const homes=new Map(), strokes=[];
  function updateHome(id,pos){
    const layer=$('homes');
    let house=homes.get(id);
    if(!pos){house?.remove();homes.delete(id);return;}
    if(!house){
      house=document.createElement('div');house.className='little-house';
      const roof=make('span','house-roof','');
      const body=make('span','house-body','');
      const door=make('span','house-door','');
      const name=make('span','house-name','');
      house.append(roof,body,door,name);layer.append(house);homes.set(id,house);
    }
    house.style.left=(pos.x*100)+'%';house.style.top=(pos.y*100)+'%';house.dataset.x=pos.x;house.dataset.y=pos.y;
    house.querySelector('.house-name').textContent=(pos.name || players.get(id)?.name || 'だれか')+'の家';
  }
  $('home-button').addEventListener('click',()=>{
    if(!connected)return setMapMessage('オンラインにつながってから家を置いてね。');
    placingHome=!placingHome;field.classList.toggle('placing-home',placingHome);
    $('home-button').textContent=placingHome?'キャンセル（配置中）':'🏡 家を置く／引っ越す';
    setMapMessage(placingHome?'好きな土地をクリックしてログハウスを置いてね！':'家の配置をキャンセルしたよ。');
  });
  $('home-remove').addEventListener('click',()=>{
    if(!connected || !myId)return;
    send({type:'home',pos:null});updateHome(ownerId,null);endPlacement();setMapMessage('ログハウスを収納したよ。いつでもまた置けます！');
  });
  function showCatch(data){
    const found=({ '小さな魚':'🐟', '中くらいの魚':'🐠', 'マグロ':'🐟', 'シーラカンス':'🦕' })[data.fish] || '🐟';
    const player=players.get(data.id);
    const name=player?.name || 'だれか';
    const mine=data.id===myId;
    const msg=`${found} ${name}が「${data.fish}」を釣り上げた！${data.fish==='シーラカンス'?' 超激レア！！':''}`;
    $('fishing-notice').textContent=msg;
    clearTimeout(showCatch.timer);showCatch.timer=setTimeout(()=>$('fishing-notice').textContent='',4500);
    if(player){ talk({id:data.id,text:`${found} ${data.fish} ゲット！`}); }
    if(mine){$('fish-button').textContent='🎣 さかなを釣る';$('fish-button').disabled=false;}
  }
  $('fish-button').addEventListener('click',()=>{
    if(!connected)return setMapMessage('オンラインにつながってから釣ってね。');
    const button=$('fish-button');button.disabled=true;button.textContent='🎣 ウキがピクピク…';
    $('fishing-notice').textContent='水面がゆらゆら……';
    setTimeout(()=>{
      if(connected)send({type:'fish'});
      setTimeout(()=>{if(button.disabled){button.disabled=false;button.textContent='🎣 さかなを釣る';}},1800);
    },950);
  });
  $('pond').addEventListener('click',()=> $('fish-button').click());

  const artDialog=$('art-dialog'),canvas=$('draw-canvas'),dc=canvas.getContext('2d');
  let selectedColor='#e24b45',drawing=false,lastPoint=null;
  function drawStroke(stroke){
    if(!stroke || !Array.isArray(stroke.points) || stroke.points.length!==4)return;
    const [x1,y1,x2,y2]=stroke.points;
    dc.lineWidth=4;dc.lineCap='round';dc.lineJoin='round';dc.strokeStyle=stroke.color;
    dc.beginPath();dc.moveTo(x1*canvas.width,y1*canvas.height);dc.lineTo(x2*canvas.width,y2*canvas.height);dc.stroke();
  }
  function redrawCanvas(){dc.fillStyle='#fffefa';dc.fillRect(0,0,canvas.width,canvas.height);strokes.forEach(drawStroke);}
  function addStroke(stroke){
    strokes.push(stroke);if(strokes.length>1500)strokes.shift();
    if(!artDialog.hidden)drawStroke(stroke);
  }
  function openArt(){artDialog.hidden=false;redrawCanvas();}
  function closeArt(){artDialog.hidden=true;drawing=false;}
  $('art-button').addEventListener('click',openArt);
  $('art-spot').addEventListener('click',openArt);
  $('art-close').addEventListener('click',closeArt);
  artDialog.addEventListener('pointerdown',e=>{if(e.target===artDialog)closeArt();});
  document.querySelectorAll('.art-color').forEach(button=>button.addEventListener('click',()=>{
    selectedColor=button.dataset.color;document.querySelectorAll('.art-color').forEach(b=>b.classList.toggle('selected',b===button));
  }));
  $('art-clear').addEventListener('click',()=>{
    if(!connected)return;
    if(confirm('みんなのキャンバスを真っ白に戻しますか？'))send({type:'clear_canvas'});
  });
  function localPoint(e){const r=canvas.getBoundingClientRect();return {x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};}
  canvas.addEventListener('pointerdown',e=>{if(!connected)return;e.preventDefault();drawing=true;lastPoint=localPoint(e);canvas.setPointerCapture(e.pointerId);});
  canvas.addEventListener('pointermove',e=>{
    if(!drawing || !connected)return;
    e.preventDefault();const next=localPoint(e);const stroke={color:selectedColor,points:[lastPoint.x,lastPoint.y,next.x,next.y]};
    if(Math.hypot(next.x-lastPoint.x,next.y-lastPoint.y)<.001)return;
    send({type:'draw',color:selectedColor,points:stroke.points});lastPoint=next;
  });
  for(const event of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(event,()=>{drawing=false;lastPoint=null;});
  redrawCanvas();

  placeCamera(); displayOwnAvatar(); connect();
})();
