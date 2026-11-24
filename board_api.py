"""Simple demo noticeboards: same two city boards across all game rooms.
SQLite is local to the host: Render's free ephemeral filesystem is NOT durable.
"""
import base64
import binascii
import hashlib
import io
import json
import os
import re
import secrets
import sqlite3
import time
from pathlib import Path
from aiohttp import web
from PIL import Image, ImageOps, UnidentifiedImageError

DB_FILE = Path(os.environ.get('BOARD_DB_PATH', str(Path(__file__).resolve().parent / 'board_data.sqlite3')))
BOARD_IDS = {'niihama', 'saijo'}
TOKEN_RE = re.compile(r'^[a-f0-9]{32}$')
ID_RE = re.compile(r'^[a-f0-9]{24}$')
MAX_JSON_BYTES = 1_300_000
MAX_IMAGES = 3
MAX_IMAGE_BYTES = 240_000
RATE_SECONDS = 12
_last_post = {}


def connection():
    DB_FILE.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_FILE, timeout=10)
    conn.execute('PRAGMA busy_timeout = 10000')
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('''CREATE TABLE IF NOT EXISTS board_posts (
        id TEXT PRIMARY KEY, board TEXT NOT NULL, author TEXT NOT NULL,
        content TEXT NOT NULL, created_at INTEGER NOT NULL,
        owner_digest TEXT NOT NULL
    )''')
    conn.execute('''CREATE TABLE IF NOT EXISTS board_images (
        post_id TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL,
        PRIMARY KEY(post_id,idx), FOREIGN KEY(post_id) REFERENCES board_posts(id)
    )''')
    conn.execute('CREATE INDEX IF NOT EXISTS ix_board_posts ON board_posts(board, created_at DESC)')
    return conn


def post_public(row, num_images=0):
    return {'id':row[0], 'board':row[1], 'author':row[2], 'text':row[3],
            'created_at':row[4], 'images':[f'/api/boards/images/{row[0]}/{i}' for i in range(num_images)]}


def board_id(request):
    board = request.match_info['board']
    if board not in BOARD_IDS:
        raise web.HTTPNotFound(text='掲示板が見つかりません。')
    return board


def digest(token):
    return hashlib.sha256(token.encode('ascii')).hexdigest()


async def list_posts(request):
    board = board_id(request)
    after = request.query.get('before', '')
    try:
        before = int(after) if after else None
    except ValueError:
        raise web.HTTPBadRequest(text='不正な日時です。')
    with connection() as c:
        if before:
            rows = c.execute('SELECT id,board,author,content,created_at FROM board_posts WHERE board=? AND created_at<? ORDER BY created_at DESC LIMIT 30', (board,before)).fetchall()
        else:
            rows = c.execute('SELECT id,board,author,content,created_at FROM board_posts WHERE board=? ORDER BY created_at DESC LIMIT 30', (board,)).fetchall()
        result=[]
        for row in rows:
            count=c.execute('SELECT COUNT(*) FROM board_images WHERE post_id=?',(row[0],)).fetchone()[0]
            result.append(post_public(row,count))
    return web.json_response({'posts':result},headers={'Cache-Control':'no-store'})


def reencode_image(encoded):
    if not isinstance(encoded,str) or len(encoded)>400_000:
        raise web.HTTPBadRequest(text='画像が大きすぎます。')
    try:
        raw=base64.b64decode(encoded, validate=True)
        if len(raw)>MAX_IMAGE_BYTES:
            raise ValueError('size')
        with Image.open(io.BytesIO(raw)) as image:
            if image.format not in ('JPEG','PNG','WEBP'):
                raise ValueError('type')
            if image.width*image.height>20_000_000:
                raise ValueError('dimensions')
            image=ImageOps.exif_transpose(image)
            image.thumbnail((1280,1280),Image.Resampling.LANCZOS)
            if image.mode not in ('RGB','L'):
                base=Image.new('RGB',image.size,'white')
                if 'A' in image.getbands(): base.paste(image,mask=image.getchannel('A'))
                else: base.paste(image.convert('RGB'))
                image=base
            else: image=image.convert('RGB')
            output=io.BytesIO()
            image.save(output,format='JPEG',quality=76,optimize=True)
            final=output.getvalue()
            if len(final)>MAX_IMAGE_BYTES:
                output=io.BytesIO()
                image.save(output,format='JPEG',quality=58,optimize=True)
                final=output.getvalue()
            if len(final)>MAX_IMAGE_BYTES:raise ValueError('size')
            return final
    except (binascii.Error, ValueError, TypeError, UnidentifiedImageError, OSError):
        raise web.HTTPBadRequest(text='画像を読み取れません。軽量なJPEG/PNG/WebPを選んでね。')


async def add_post(request):
    board=board_id(request)
    if request.content_length and request.content_length>MAX_JSON_BYTES:
        raise web.HTTPRequestEntityTooLarge(max_size=MAX_JSON_BYTES, actual_size=request.content_length)
    try: data=await request.json()
    except (ValueError,UnicodeError): raise web.HTTPBadRequest(text='投稿データが不正です。')
    if not isinstance(data,dict): raise web.HTTPBadRequest(text='投稿データが不正です。')
    author=data.get('author',''); content=data.get('text',''); token=data.get('token',''); images=data.get('images',[])
    if not isinstance(author,str) or not (1<=len(author.strip())<=16):
        raise web.HTTPBadRequest(text='名前は1〜16文字にしてね。')
    if not isinstance(content,str) or len(content.strip())>140 or (not content.strip() and not images):
        raise web.HTTPBadRequest(text='文章は140文字以内で、文章または画像を入れてね。')
    if not isinstance(token,str) or not TOKEN_RE.fullmatch(token):
        raise web.HTTPBadRequest(text='投稿の識別情報がありません。')
    if not isinstance(images,list) or len(images)>MAX_IMAGES:
        raise web.HTTPBadRequest(text='画像は最大3枚までです。')
    compressed=[reencode_image(img) for img in images]
    client=request.remote or 'unknown'
    key=(client,digest(token))
    now=time.monotonic()
    if now-_last_post.get(key,0)<RATE_SECONDS:
        raise web.HTTPTooManyRequests(text='連続投稿は12秒空けてね。')
    post_id=secrets.token_hex(12)
    created=int(time.time()*1000)
    with connection() as c:
        c.execute('INSERT INTO board_posts VALUES(?,?,?,?,?,?)',(post_id,board,author.strip(),content.strip(),created,digest(token)))
        c.executemany('INSERT INTO board_images VALUES(?,?,?)',[(post_id,i,blob) for i,blob in enumerate(compressed)])
    _last_post[key]=now
    return web.json_response({'post':post_public((post_id,board,author.strip(),content.strip(),created),len(compressed))},status=201)


async def serve_image(request):
    ident=request.match_info['post_id']
    try: idx=int(request.match_info['idx'])
    except ValueError: raise web.HTTPNotFound()
    if not ID_RE.fullmatch(ident) or idx not in range(MAX_IMAGES):raise web.HTTPNotFound()
    with connection() as c:
        row=c.execute('SELECT data FROM board_images WHERE post_id=? AND idx=?',(ident,idx)).fetchone()
    if row is None:raise web.HTTPNotFound()
    return web.Response(body=row[0],content_type='image/jpeg',headers={'Cache-Control':'public, max-age=3600','X-Content-Type-Options':'nosniff'})


async def remove_post(request):
    board=board_id(request)
    ident=request.match_info['post_id']
    if not ID_RE.fullmatch(ident):raise web.HTTPNotFound()
    try: data=await request.json()
    except (ValueError,UnicodeError):raise web.HTTPBadRequest()
    token=data.get('token','') if isinstance(data,dict) else ''
    admin=os.environ.get('BOARD_ADMIN_TOKEN','')
    authorized_admin=bool(admin and secrets.compare_digest(data.get('admin','') if isinstance(data,dict) else '',admin))
    with connection() as c:
        row=c.execute('SELECT owner_digest FROM board_posts WHERE id=? AND board=?',(ident,board)).fetchone()
        if row is None:raise web.HTTPNotFound()
        if not authorized_admin and (not isinstance(token,str) or not TOKEN_RE.fullmatch(token) or not secrets.compare_digest(row[0],digest(token))):
            raise web.HTTPForbidden(text='自分の投稿だけ削除できます。')
        c.execute('DELETE FROM board_images WHERE post_id=?',(ident,))
        c.execute('DELETE FROM board_posts WHERE id=?',(ident,))
    return web.json_response({'ok':True})


def register(app):
    app.router.add_get('/api/boards/{board}/posts',list_posts)
    app.router.add_post('/api/boards/{board}/posts',add_post)
    app.router.add_delete('/api/boards/{board}/posts/{post_id}',remove_post)
    app.router.add_get('/api/boards/images/{post_id}/{idx}',serve_image)
