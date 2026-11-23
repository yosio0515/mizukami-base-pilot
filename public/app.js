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

  const roadLines = [
    [[0.17,0.27],[0.17,0.44],[0.17,0.61]],
    [[0.17,0.61],[0.29,0.61],[0.40,0.60],[0.54,0.58],[0.69,0.58],[0.82,0.60]],
    [[0.40,0.39],[0.40,0.60],[0.43,0.78]],
    [[0.54,0.41],[0.54,0.58],[0.58,0.78]],
    [[0.69,0.44],[0.69,0.58],[0.78,0.79]],
    [[0.82,0.44],[0.82,0.60],[0.84,0.86]],
    [[0.37,0.34],[0.46,0.41],[0.54,0.41],[0.69,0.44],[0.82,0.44]],
    [[0.29,0.61],[0.31,0.70],[0.22,0.83],[0.10,0.82]],
    [[0.43,0.78],[0.58,0.78],[0.78,0.79],[0.90,0.88]],
    [[0.37,0.34],[0.39,0.28],[0.48,0.28]],
    [[0.69,0.44],[0.73,0.27],[0.86,0.18]]
  ];
  function buildRoadGraph(lines, step=.02){
    const nodes = [];
    const adjacency = new Map();
    const byKey = new Map();
    const getId = (x, y) => {
      const key = `${x.toFixed(4)},${y.toFixed(4)}`;
      if (!byKey.has(key)) {
        const id = nodes.length;
        nodes.push({x, y});
        adjacency.set(id, new Set());
        byKey.set(key, id);
      }
      return byKey.get(key);
    };
    for (const line of lines) {
      let prevId = null;
      for (let i = 0; i < line.length - 1; i++) {
        const [x1,y1] = line[i], [x2,y2] = line[i+1];
        const dist = Math.hypot(x2-x1, y2-y1);
        const parts = Math.max(1, Math.ceil(dist / step));
        for (let j = 0; j <= parts; j++) {
          if (i > 0 && j === 0) continue;
          const t = j / parts;
          const x = x1 + (x2-x1)*t;
          const y = y1 + (y2-y1)*t;
          const id = getId(x, y);
          if (prevId != null && prevId !== id) {
            adjacency.get(prevId).add(id);
            adjacency.get(id).add(prevId);
          }
          prevId = id;
        }
      }
    }
    return {nodes, adjacency};
  }
  const roadGraph = buildRoadGraph(roadLines, .018);
  function nearestRoadNode(x, y) {
    let best = 0, bestDist = Infinity;
    roadGraph.nodes.forEach((node, index) => {
      const d = (node.x-x)*(node.x-x) + (node.y-y)*(node.y-y);
      if (d < bestDist) { bestDist = d; best = index; }
    });
    return best;
  }
  function shortestRoadPath(startId, endId) {
    if (startId === endId) return [startId];
    const prev = new Map([[startId, null]]);
    const queue = [startId];
    for (let head = 0; head < queue.length; head++) {
      const id = queue[head];
      if (id === endId) break;
      for (const next of roadGraph.adjacency.get(id) || []) {
        if (prev.has(next)) continue;
        prev.set(next, id);
        queue.push(next);
      }
    }
    if (!prev.has(endId)) return [startId];
    const ids = [];
    for (let cur = endId; cur != null; cur = prev.get(cur)) ids.push(cur);
    return ids.reverse();
  }
  function roadPoint(id){ return roadGraph.nodes[id]; }
  function snapPlayerToRoad(player){
    const id = nearestRoadNode(player.x, player.y);
    const point = roadPoint(id);
    player.x = point.x; player.y = point.y;
    return id;
  }

  function setMapMessage(text) {
    const note = $('map-note');
    if (!note) return;
    note.textContent = text;
    clearTimeout(setMapMessage.timer);
    setMapMessage.timer = setTimeout(() => {
      note.textContent = 'β版マップ：クリック／タップ移動は道に沿って歩きます。建物ルーム移動は今後追加予定です。';
    }, 5000);
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

  let walkRoute = [];
  function routeToRoadTarget(targetX, targetY) {
    if (!myId || !players.has(myId)) return;
    const p = players.get(myId);
    const startId = nearestRoadNode(p.x, p.y);
    const endId = nearestRoadNode(targetX, targetY);
    const routeIds = shortestRoadPath(startId, endId);
    walkRoute = routeIds.slice(1).map(id => ({...roadPoint(id)}));
    if (!walkRoute.length) {
      const same = roadPoint(endId);
      walkRoute = [{x: same.x, y: same.y}];
    }
  }

  function connect(){
    status('接続中…',false);
    const proto = location.protocol==='https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws?room=${encodeURIComponent(room)}&password=${encodeURIComponent(password)}`);
    ws.addEventListener('open',()=>{ connected = true; status('オンライン',true); });
    ws.addEventListener('message',event=>{
      let data; try{ data = JSON.parse(event.data); } catch { return; }
      if(data.type==='welcome'){
        myId = data.id; players.clear(); $('characters').replaceChildren(); data.players.forEach(updatePlayer);
        if (players.has(myId)) {
          const me = players.get(myId);
          snapPlayerToRoad(me);
          render();
          send({type:'move',x:me.x,y:me.y});
        }
        send({type:'name',name:profile.name}); send({type:'avatar',avatar:profile.avatar});
      }
      if (['join','move','name','avatar'].includes(data.type)) {
        if (data.type === 'move' && data.id === myId) return;
        updatePlayer(data);
      }
      if(data.type==='leave'){ const p = players.get(data.id); p?.el?.remove(); players.delete(data.id); render(); }
      if(data.type==='chat') talk(data);
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

  const field = $('field');
  field.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !connected || !myId) return;
    if (e.target.closest('button, input, .character')) return;
    const bounds = field.getBoundingClientRect();
    const targetX = Math.max(.06, Math.min(.94, (e.clientX - bounds.left)/bounds.width));
    const targetY = Math.max(.10, Math.min(.90, (e.clientY - bounds.top)/bounds.height));
    routeToRoadTarget(targetX, targetY);
  });

  let last = performance.now();
  setInterval(()=>{
    const now = performance.now(), dt = Math.min((now-last)/1000,.1); last = now;
    if(!connected || !myId || !players.has(myId)) return;
    const p = players.get(myId), speed = .34;
    let dx = 0, dy = 0;
    if (active.size) {
      walkRoute = [];
      for (const key of active) {
        const v = keys[key]; if (v) { dx += v[0]; dy += v[1]; }
      }
    } else if (walkRoute.length) {
      dx = walkRoute[0].x - p.x; dy = walkRoute[0].y - p.y;
      if (Math.hypot(dx,dy) < .008) {
        walkRoute.shift();
        if (!walkRoute.length) return;
        dx = walkRoute[0].x - p.x; dy = walkRoute[0].y - p.y;
      }
    } else return;
    const d = Math.hypot(dx,dy); if (!d) return;
    const step = Math.min(speed*dt, d);
    p.movingUntil = now + 145;
    p.x = Math.max(.05, Math.min(.95, p.x + dx/d*step));
    p.y = Math.max(.10, Math.min(.90, p.y + dy/d*step));
    if (walkRoute.length && Math.hypot(walkRoute[0].x-p.x, walkRoute[0].y-p.y) < .008) walkRoute.shift();
    render(); send({type:'move',x:p.x,y:p.y});
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
  displayOwnAvatar(); connect();
})();
