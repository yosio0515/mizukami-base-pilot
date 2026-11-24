"""Mizukami Base: up-to-ten-person real-time proof of concept."""
import asyncio
import base64
import binascii
import json
import os
import re
import secrets
import time
import random
import math
from pathlib import Path
from aiohttp import web, WSMsgType
from board_api import register as register_boards

ROOT = Path(__file__).resolve().parent
ROOMS = {}
WORLD = {}  # Room-scoped, in-memory demo state. Resets on restart.
DRAW_LIMIT = 1500
MAX_CHAT = 80
MAX_PLAYERS = 10
MAX_AVATAR_BYTES = 24000
ROOM_RE = re.compile(r'^[a-zA-Z0-9_-]{1,32}$')

# v2.2: coordinates are normalized across the 7800x4800 wide-world canvas.
WORLD_W, WORLD_H = 7800.0, 4800.0
HUBS = ((1550,1950,155,145,125),(3960,2310,155,145,125),(6390,1900,155,145,125),(4300,1030,325,155,165))
BRIDGES = (1540,2660,3650)
GRAVEL = (
 ((1550,2075),(1600,2390),(1850,2650),(2500,2700),(3200,2670),(3940,2700),(4620,2700),(5450,2630),(6390,2060)),
 ((3900,2710),(3890,2100),(4140,1650),(4300,1230)),
 ((1500,1950),(1770,1800),(2070,1630),(2400,1540),(3000,1630),(3500,1740),(4110,1760),(4630,1810),(5280,1670),(5920,1770),(6350,1890)),
 ((450,3460),(1400,3510),(2550,3530),(4000,3450),(5600,3490),(7000,3530)),
 ((1800,3530),(1900,3000),(1800,2730)),
 ((6200,3500),(6140,2900),(6380,2190)),
 ((4200,3510),(4360,2880)),
)

def road_at(x,y): return abs(y-(2850+55*math.sin(x*.0009))) < 58

def gravel_at(x,y):
    for line in GRAVEL:
        for (ax,ay),(bx,by) in zip(line,line[1:]):
            vx,vy=bx-ax,by-ay
            t=max(0,min(1,((x-ax)*vx+(y-ay)*vy)/(vx*vx+vy*vy or 1)))
            if math.hypot(x-(ax+vx*t),y-(ay+vy*t))<33:
                return True
    return False

def blocked(x,y):
    xx,yy=x*WORLD_W,y*WORLD_H
    if xx<35 or xx>WORLD_W-35 or yy<40 or yy>WORLD_H-40:
        return True
    if yy<470+42*math.sin(xx*.0013)+37*math.cos(xx*.0036):return True
    if yy>4200+150*math.sin(xx*.0014)+95*math.sin(xx*.004):return True
    on_bridge=any(abs(yy-v)<70 for v in BRIDGES)
    if not on_bridge and any(abs(xx-((2520 if i==0 else 5540)+125*math.sin(yy*.002+i*1.7)+42*math.sin(yy*.006+i)))<52 for i in (0,1)):
        return True
    for hx,hy,half,top,bottom in HUBS:
        if hx-half-25<xx<hx+half+25 and hy-top-25<yy<hy+bottom+25:
            return True
    return False

def can_build(x,y,homes,owner_id,room=None):
    xx,yy=x*WORLD_W,y*WORLD_H
    if blocked(x,y) or yy<650 or road_at(xx,yy) or gravel_at(xx,yy):
        return False
    if any(hx-half-235<xx<hx+half+235 and hy-top-235<yy<hy+bottom+235 for hx,hy,half,top,bottom in HUBS):
        return False
    if any(math.hypot((x-h['x'])*WORLD_W,(y-h['y'])*WORLD_H)<170 for hid,h in homes.items() if hid!=owner_id):
        return False
    if room and any(math.hypot((x-p['x'])*WORLD_W,(y-p['y'])*WORLD_H)<70 for p in room.values()):
        return False
    return True

def segment_passable(x1,y1,x2,y2,homes=None):
    d=math.hypot((x2-x1)*WORLD_W,(y2-y1)*WORLD_H)
    count=max(2,math.ceil(d/16))
    for i in range(1,count+1):
        t=i/count;x=x1+(x2-x1)*t;y=y1+(y2-y1)*t
        if blocked(x,y) or (homes and any(math.hypot((x-h['x'])*WORLD_W,(y-h['y'])*WORLD_H)<75 for h in homes.values())):
            return False
    return True

async def index(request):
    return web.FileResponse(ROOT / 'public' / 'index.html')

async def health(request):
    return web.json_response({'ok': True, 'active_rooms': len(ROOMS)})

async def ws_handler(request):
    room_id = request.query.get('room', 'main')
    if not ROOM_RE.fullmatch(room_id):
        return web.Response(status=400, text='Invalid room')
    secret = os.environ.get('ROOM_PASSWORD', '')
    if secret and not secrets.compare_digest(request.query.get('password', ''), secret):
        return web.Response(status=403, text='Incorrect room password')
    room = ROOMS.setdefault(room_id, {})
    world = WORLD.setdefault(room_id, {'homes': {}, 'strokes': []})
    if len(room) >= MAX_PLAYERS:
        return web.Response(status=409, text='This room is full (10 participants)')
    ws = web.WebSocketResponse(heartbeat=30, max_msg_size=65536)
    await ws.prepare(request)
    player_id = secrets.token_hex(8)
    owner_token = request.query.get('owner','')
    owner_id = ('owner-' + owner_token) if re.fullmatch(r'[a-f0-9]{24,40}',owner_token) else player_id
    slot = len(room)
    # Start everyone on the shared crossroads near Mizukami Paint.
    spawn_x = (3790 + (slot%5)*42)/WORLD_W
    spawn_y = (2720 + (slot//5)*50)/WORLD_H
    if blocked(spawn_x,spawn_y):
        spawn_x,spawn_y = 3900/WORLD_W,2720/WORLD_H
    room[player_id] = {'ws': ws, 'x': spawn_x, 'y': spawn_y, 'name': '参加者', 'avatar': None}

    async def send_all(data):
        packet = json.dumps(data, ensure_ascii=False)
        for participant in list(room.values()):
            if not participant['ws'].closed:
                try:
                    await participant['ws'].send_str(packet)
                except (ConnectionError, RuntimeError):
                    pass

    try:
        await ws.send_json({'type': 'welcome', 'id': player_id, 'players': [{'id': pid, 'x': p['x'], 'y': p['y'], 'name': p['name'], 'avatar': p['avatar']} for pid, p in room.items()], 'world': {'homes': world['homes'], 'strokes': world['strokes']}})
        await send_all({'type': 'join', 'id': player_id, 'x': room[player_id]['x'], 'y': room[player_id]['y'], 'name': '参加者', 'avatar': None})
        last_movement = 0
        last_chat = 0
        last_fish = 0
        last_draw = 0
        last_home = 0
        async for event in ws:
            if event.type != WSMsgType.TEXT:
                if event.type == WSMsgType.ERROR:
                    break
                continue
            try:
                data = json.loads(event.data)
            except (json.JSONDecodeError, ValueError):
                continue
            if not isinstance(data, dict):
                continue
            kind = data.get('type')
            now = time.monotonic()
            if kind == 'move' and now - last_movement >= .025:
                try:
                    x, y = float(data['x']), float(data['y'])
                except (ValueError, TypeError, KeyError):
                    continue
                if not (0 <= x <= 1 and 0 <= y <= 1):
                    continue
                p = room.get(player_id)
                if p is None:
                    break
                # Limit speed to ~0.65 arena widths per second, with some latency allowance.
                delta = max(.025, min(now - last_movement if last_movement else .05, .15))
                if math.hypot((x-p['x'])*WORLD_W,(y-p['y'])*WORLD_H) > 125 * delta + 22:
                    continue
                if not segment_passable(p['x'],p['y'],x,y,world['homes']):
                    continue
                p['x'], p['y'] = x, y
                last_movement = now
                await send_all({'type': 'move', 'id': player_id, 'x': x, 'y': y})
            elif kind == 'chat' and now - last_chat >= .45:
                msg = data.get('text')
                if not isinstance(msg, str):
                    continue
                msg = msg.strip()[:MAX_CHAT]
                if not msg:
                    continue
                last_chat = now
                await send_all({'type': 'chat', 'id': player_id, 'text': msg, 'at': int(time.time() * 1000)})
            elif kind == 'fish' and now - last_fish >= 2.6:
                # Server chooses fish so everyone sees the same catch.
                last_fish = now
                r = random.random()
                if r < .70:
                    fish = '小さな魚'
                elif r < .955:
                    fish = '中くらいの魚'
                elif r < .997:
                    fish = 'マグロ'
                else:
                    fish = 'シーラカンス'
                await send_all({'type':'fish_result','id':player_id,'fish':fish})
            elif kind == 'home' and now - last_home >= .6:
                pos = data.get('pos')
                if pos is not None:
                    if not isinstance(pos, dict):
                        continue
                    try:
                        hx = float(pos['x']); hy = float(pos['y'])
                    except (KeyError, ValueError, TypeError):
                        continue
                    if not can_build(hx,hy,world['homes'],owner_id,room):
                        await ws.send_json({'type':'home_error','message':'その場所は建築できないよ。草地の空き地を選んでね！'})
                        continue
                    pos = {'x':round(hx,4),'y':round(hy,4)}
                last_home = now
                if pos is None:
                    world['homes'].pop(owner_id, None)
                else:
                    pos['name'] = room[player_id]['name']
                    world['homes'][owner_id] = pos
                await send_all({'type':'home','id':owner_id,'pos':pos})
            elif kind == 'draw' and now - last_draw >= .012:
                points = data.get('points')
                color = data.get('color')
                if color not in ('#e24b45','#326fcb','#242b36') or not isinstance(points,list) or len(points) != 4:
                    continue
                try:
                    coords = [float(v) for v in points]
                except (ValueError, TypeError):
                    continue
                if not all(0 <= v <= 1 for v in coords):
                    continue
                last_draw = now
                stroke = {'points':[round(v,4) for v in coords], 'color':color}
                world['strokes'].append(stroke)
                if len(world['strokes']) > DRAW_LIMIT:
                    world['strokes'] = world['strokes'][-DRAW_LIMIT:]
                await send_all({'type':'draw','stroke':stroke})
            elif kind == 'clear_canvas' and now - last_home >= 2:
                last_home = now
                world['strokes'] = []
                await send_all({'type':'clear_canvas'})
            elif kind == 'avatar':
                avatar = data.get('avatar')
                if avatar is not None:
                    if not isinstance(avatar, str) or not avatar.startswith('data:image/jpeg;base64,') or len(avatar) > 33000:
                        continue
                    try:
                        raw = base64.b64decode(avatar.split(',', 1)[1], validate=True)
                    except (binascii.Error, ValueError):
                        continue
                    if not (100 <= len(raw) <= MAX_AVATAR_BYTES and raw[:3] == b'\xff\xd8\xff' and raw[-2:] == b'\xff\xd9'):
                        continue
                room[player_id]['avatar'] = avatar
                await send_all({'type': 'avatar', 'id': player_id, 'avatar': avatar})
            elif kind == 'name':
                name = data.get('name', '')
                if isinstance(name, str):
                    name = name.strip()[:16] or '参加者'
                    room[player_id]['name'] = name
                    await send_all({'type': 'name', 'id': player_id, 'name': name})
                    if owner_id in world['homes']:
                        world['homes'][owner_id]['name'] = name
                        await send_all({'type':'home','id':owner_id,'pos':world['homes'][owner_id]})
    finally:
        room.pop(player_id, None)
        if room:
            await send_all({'type': 'leave', 'id': player_id})
        else:
            ROOMS.pop(room_id, None)
            # Houses and shared drawing remain in memory while the server lives.
    return ws

app = web.Application()
app.router.add_get('/', index)
register_boards(app)
app.router.add_get('/health', health)
app.router.add_get('/ws', ws_handler)
app.router.add_static('/static/', ROOT / 'public', show_index=False)

if __name__ == '__main__':
    web.run_app(app, host='0.0.0.0', port=int(os.environ.get('PORT', '8080')))
