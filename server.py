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

# v1.8: approximate map geometry; replace with polygon/tile collision masks in v2.x.
LANDMARK_BLOCKS = (
    (.22,.29,.19,.27), (.32,.39,.30,.37), (.55,.64,.22,.32),
    (.69,.78,.29,.38), (.78,.87,.34,.43), (.17,.29,.48,.57),
    (.76,.88,.49,.57), (.23,.32,.64,.75), (.76,.86,.64,.75),
)

def blocked(x, y):
    if not (.025 <= x <= .975 and .245 <= y <= .81):
        return True
    bridge = abs(y-.475) < .023 or abs(y-.578) < .020
    if not bridge and (abs(x-(.36+.012*math.sin(15*y))) < .014
                       or abs(x-(.685+.016*math.sin(17*y))) < .015):
        return True
    return any(l <= x <= r and t <= y <= b for l,r,t,b in LANDMARK_BLOCKS)

def can_build(x, y, homes, owner_id, room=None):
    if blocked(x,y) or not (.29 <= y <= .755):
        return False
    if abs(y-.473)<.031 or abs(y-.58)<.030:
        return False
    if room and any(math.hypot(x-p['x'],y-p['y']) < .055 for p in room.values()):
        return False
    for hid,h in homes.items():
        if hid != owner_id and math.hypot(x-h['x'],y-h['y']) < .085:
            return False
    return True

def segment_passable(x1,y1,x2,y2,homes=None):
    d=math.hypot(x2-x1,y2-y1)
    for i in range(1,max(2,math.ceil(d/.005))+1):
        t=i/max(2,math.ceil(d/.005))
        x=x1+(x2-x1)*t; y=y1+(y2-y1)*t
        if blocked(x,y) or (homes and any(math.hypot(x-h['x'],y-h['y']) < .032 for h in homes.values())):
            return False
    return True

async def index(request):
    return web.FileResponse(ROOT / 'public' / 'index.html')

async def health(request):
    return web.json_response({'ok': True, 'active_rooms': len(ROOMS)})

async def ws_handler(request):
    room_id = request.query.get('room', 'demo')
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
    # Spread new participants across two rows to avoid ten dots stacking.
    spawn_x = 0.15 + (slot % 5) * 0.175
    spawn_y = 0.36 if slot < 5 else 0.64
    # Spawn players on land and outside protected landmark footprints.
    if blocked(spawn_x, spawn_y):
        for candidate_y in (.41, .64, .68, .52, .72):
            if not blocked(spawn_x,candidate_y):
                spawn_y=candidate_y
                break
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
                if ((x-p['x'])**2 + (y-p['y'])**2) ** .5 > .65 * delta + .035:
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
