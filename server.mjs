import http from 'node:http';
import https from 'node:https';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { prepareTranscription, transcriptionStatus } from './transcribe.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const defaultStore =
  process.platform === 'darwin'
    ? path.join(homedir(), 'Library', 'Application Support', 'Atlas Meet', 'rooms')
    : path.join(root, 'data', 'rooms');
const store = path.resolve(process.env.ATLAS_DATA_DIR || defaultStore);
await mkdir(store, { recursive: true, mode: 0o700 });
const iceServers = JSON.parse(process.env.ICE_SERVERS || '[]');
if (!Array.isArray(iceServers) || iceServers.some((s) => !s?.urls)) throw Error('Invalid ICE_SERVERS');

async function configuredSecret(name) {
  const value = process.env[name];
  const file = process.env[name + '_FILE'];
  if (value && file) throw Error(`Choose either ${name} or ${name}_FILE`);
  if (!file && !value) return null;
  const secret = (file ? await readFile(file, 'utf8') : value).trim();
  if (!secret) throw Error(`${name} is empty`);
  return secret;
}
const roomKey = await configuredSecret('ROOM_CREATION_KEY');
const keyDigest = (value) => createHash('sha256').update(value).digest();
const roomKeyDigest = roomKey && keyDigest(roomKey);

// coturn authenticates the expiration timestamp and participant ID with a shared HMAC key.
async function readTurnConfig(env) {
  const { TURN_URLS, TURN_PUBLIC_HOST, TURN_SHARED_SECRET, TURN_SHARED_SECRET_FILE } = env;
  if (!TURN_URLS && !TURN_PUBLIC_HOST && !TURN_SHARED_SECRET && !TURN_SHARED_SECRET_FILE) return null;
  if (!TURN_URLS && !TURN_PUBLIC_HOST) throw Error('Configure TURN_URLS or TURN_PUBLIC_HOST');
  const secret = await configuredSecret('TURN_SHARED_SECRET');
  if (!secret) throw Error('Configure a TURN shared secret');
  const ttl = Number(env.TURN_TTL_SECONDS || 3600);
  if (!Number.isInteger(ttl) || ttl < 600 || ttl > 86400) {
    throw Error('TURN_TTL_SECONDS must be an integer between 600 and 86400');
  }
  const raw = TURN_URLS?.trim();
  const urls = raw
    ? raw.startsWith('[')
      ? JSON.parse(raw)
      : raw.split(',').map((url) => url.trim())
    : ['udp', 'tcp'].map((transport) => `turn:${TURN_PUBLIC_HOST}:3478?transport=${transport}`);
  const validUrl = (url) => {
    if (typeof url !== 'string') return false;
    const match = /^turns?:([a-z0-9.-]+|\[[a-f0-9:.]+\])(?::([0-9]+))?(?:\?transport=(udp|tcp))?$/i.exec(
      url,
    );
    if (!match || (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535))) return false;
    try {
      return Boolean(new URL('https://' + match[1]).hostname);
    } catch {
      return false;
    }
  };
  if (!Array.isArray(urls) || !urls.length || !urls.every(validUrl)) throw Error('Invalid TURN URL');
  return { urls, ttl, secret };
}
const turn = await readTurnConfig(process.env);

function iceConfig(participantId) {
  if (!turn) return { iceServers };
  const expires = Math.floor(Date.now() / 1000) + turn.ttl;
  const username = `${expires}:${participantId}`;
  const credential = createHmac('sha1', turn.secret).update(username).digest('base64');
  return {
    iceServers: [...iceServers, { urls: turn.urls, username, credential }],
    iceExpiresAt: expires * 1000,
  };
}

const maxSeats = 8,
  maxEntries = 20000,
  ticketLifetime = 86400000;
const rooms = new Map(),
  loading = new Map();
const fail = (status, message) => Object.assign(new Error(message), { status });
const digest = (value) => createHash('sha256').update(value).digest('hex');
const roomFile = (id) => path.join(store, id + '.json');
const validId = (id) => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);

async function save(data) {
  const file = roomFile(data.roomId),
    temp = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

function cache(data) {
  const room = {
    data,
    live: new Map(),
    pending: new Map(),
    silence: new Set(),
    entries: new Map(data.transcript.map((e) => [e.id, e])),
    writes: Promise.resolve(),
    touched: Date.now(),
  };
  rooms.set(data.roomId, room);
  return room;
}

async function loadRoom(id) {
  let room = rooms.get(id);
  if (room) {
    room.touched = Date.now();
    return room;
  }
  if (!loading.has(id)) {
    const load = readFile(roomFile(id), 'utf8')
      .then((raw) => cache(JSON.parse(raw)))
      .catch((error) => {
        if (error.code === 'ENOENT')
          throw fail(404, '회의를 찾을 수 없습니다. 초대 링크를 확인해 주세요.');
        throw error;
      })
      .finally(() => loading.delete(id));
    loading.set(id, load);
  }
  return loading.get(id);
}

// All mutations of one room are serialized and acknowledged only after atomic replacement.
function change(room, build) {
  room.touched = Date.now();
  const next = room.writes.then(async () => {
    const updated = build(room.data);
    await save(updated);
    room.data = updated;
    room.touched = Date.now();
  });
  room.writes = next.catch(() => {});
  return next;
}

function info(room) {
  const { roomId, title, createdAt } = room.data;
  return { roomId, title, createdAt };
}

function history(room) {
  return [...room.data.transcript].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

function label(value, max, prompt) {
  const text = typeof value === 'string' && value.trim().replace(/[\t\n\r]/g, ' ');
  if (!text || [...text].length > max) throw fail(400, prompt);
  return text;
}

function identity(room, token) {
  const hash = typeof token === 'string' && token.length === 43 && digest(token);
  const user = hash && room.data.sessions.find((s) => s.hash === hash);
  if (!user || (Date.now() - user.issuedAt > ticketLifetime && !room.live.has(user.id))) {
    throw fail(401, '참석자 인증이 만료됐습니다. 다시 입장해 주세요.');
  }
  return user;
}

async function addSession(room, name) {
  const token = randomBytes(32).toString('base64url');
  const user = { id: randomUUID(), name, hash: digest(token), issuedAt: Date.now() };
  await change(room, (data) => {
    if (room.live.size >= maxSeats) throw fail(409, '회의 정원 8명이 모두 참석 중입니다.');
    const sessions = data.sessions.filter(
      (s) => Date.now() - s.issuedAt < ticketLifetime || room.live.has(s.id),
    );
    if (sessions.length >= 256) throw fail(429, '참석 요청이 많습니다. 잠시 후 다시 시도해 주세요.');
    return { ...data, sessions: [...sessions, user] };
  });
  return { participantId: user.id, token };
}

async function body(request, max) {
  if (Number(request.headers['content-length']) > max) throw fail(413, '전송한 데이터가 너무 큽니다.');
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > max) throw fail(413, '전송한 데이터가 너무 큽니다.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json')
    throw fail(415, 'JSON 형식으로 요청해 주세요.');
  const raw = await body(request, 8192);
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {}
  throw fail(400, '요청 형식을 확인해 주세요.');
}

function reply(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

function send(socket, value) {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > 1024 * 1024) return socket.close(1013, 'Connection too slow');
  socket.send(JSON.stringify(value));
}

function broadcast(room, value, except) {
  for (const [id, peer] of room.live) if (id !== except) send(peer.socket, value);
}

function removeConnection(room, id, socket) {
  if (room.live.get(id)?.socket !== socket) return;
  room.live.delete(id);
  room.touched = Date.now();
  broadcast(room, { type: 'peer-left', id });
}

async function ingest(request, room, user) {
  if (request.headers['content-type']?.split(';')[0] !== 'audio/wav')
    throw fail(415, 'WAV 음성 파일을 전송해 주세요.');
  const chunk = request.headers['x-chunk-id'];
  if (typeof chunk !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(chunk))
    throw fail(400, '음성 조각 식별자를 확인해 주세요.');
  const transcribe = prepareTranscription(request.headers['x-atlas-stt-provider']);
  const id = digest(user.id + '/' + chunk);
  const received = Date.now(),
    raw = request.headers['x-captured-at'];
  const captured = /^\d{13}$/.test(raw || '') ? Number(raw) : Date.parse(raw);
  const at = new Date(
    Number.isFinite(captured) ? Math.max(user.issuedAt, Math.min(received, captured)) : received,
  ).toISOString();
  const wav = await body(request, 26 * 32000 + 4096);
  if (room.entries.has(id)) return room.entries.get(id);
  if (room.silence.has(id)) return null;
  if (room.pending.has(id)) return room.pending.get(id);
  if (room.data.transcript.length >= maxEntries) throw fail(409, '이 회의의 기록 한도에 도달했습니다.');
  const job = (async () => {
    const text = (await transcribe(wav)).trim();
    if (!text) {
      room.silence.add(id);
      if (room.silence.size > 256) room.silence.delete(room.silence.values().next().value);
      return null;
    }
    const entry = { id, speakerId: user.id, speakerName: user.name, text, at };
    await change(room, (data) => {
      if (data.transcript.length >= maxEntries) throw fail(409, '이 회의의 기록 한도에 도달했습니다.');
      return { ...data, transcript: [...data.transcript, entry] };
    });
    room.entries.set(id, entry);
    broadcast(room, { type: 'transcript', entry });
    return entry;
  })();
  room.pending.set(id, job);
  try {
    return await job;
  } finally {
    room.pending.delete(id);
  }
}

function sameOrigin(request) {
  if (!request.headers.origin) return true;
  try {
    return new URL(request.headers.origin).host === request.headers.host;
  } catch {
    return false;
  }
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

async function route(request, response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  const pathname = new URL(request.url, 'http://localhost').pathname,
    method = request.method;
  if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(request))
    throw fail(403, '요청 출처를 확인해 주세요.');
  if (method === 'GET' && pathname === '/api/status')
    return reply(response, 200, {
      transcription: transcriptionStatus(),
      roomCreationRequiresKey: Boolean(roomKeyDigest),
    });
  if (method === 'POST' && pathname === '/api/rooms') {
    if (roomKeyDigest) {
      const supplied = request.headers['x-atlas-room-key'];
      if (typeof supplied !== 'string' || !timingSafeEqual(roomKeyDigest, keyDigest(supplied))) {
        throw fail(403, '회의 개설 키를 확인해 주세요.');
      }
    }
    const input = await readJson(request);
    const data = {
      roomId: randomBytes(16).toString('hex'),
      title: label(input.title, 80, '회의 제목은 1~80자로 입력해 주세요.'),
      createdAt: new Date().toISOString(),
      sessions: [],
      transcript: [],
    };
    await save(data);
    return reply(response, 201, info(cache(data)));
  }
  const match = /^\/api\/rooms\/([0-9a-f]{32})(?:\/(join|leave|audio|transcript))?$/.exec(pathname);
  if (match) {
    const [, id, action] = match;
    const room = await loadRoom(id);
    if (method === 'GET' && !action) return reply(response, 200, info(room));
    if (method === 'GET' && action === 'transcript')
      return reply(response, 200, { ...info(room), transcript: history(room) });
    if (method === 'POST' && action === 'join') {
      const { name } = await readJson(request);
      return reply(
        response,
        201,
        await addSession(room, label(name, 32, '이름은 1~32자로 입력해 주세요.')),
      );
    }
    if (method === 'POST' && (action === 'audio' || action === 'leave')) {
      const user = identity(
        room,
        /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization || '')?.[1],
      );
      if (action === 'audio') return reply(response, 200, { entry: await ingest(request, room, user) });
      await change(room, (data) => ({
        ...data,
        sessions: data.sessions.filter((s) => s.id !== user.id),
      }));
      const socket = room.live.get(user.id)?.socket;
      if (socket) {
        removeConnection(room, user.id, socket);
        socket.close(1000, 'Left meeting');
      }
      return reply(response, 200, { ok: true });
    }
    throw fail(405, '지원하지 않는 요청입니다.');
  }
  if (pathname.startsWith('/api/') || !['GET', 'HEAD'].includes(method))
    throw fail(404, '찾을 수 없습니다.');
  let asset;
  try {
    asset = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    throw fail(400, '잘못된 경로입니다.');
  }
  if (asset.includes('\0') || asset.split('/').some((part) => part.startsWith('.')))
    throw fail(404, '찾을 수 없습니다.');
  const file = path.resolve(publicDir, '.' + asset);
  if (!file.startsWith(publicDir + path.sep)) throw fail(404, '찾을 수 없습니다.');
  let bytes;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) throw fail(404, '찾을 수 없습니다.');
    throw error;
  }
  response.writeHead(200, {
    'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  response.end(method === 'HEAD' ? undefined : bytes);
}

const handler = (request, response) => {
  route(request, response).catch((error) => {
    if (!error.status) console.error('Request failed', error.code || error.name);
    if (!response.headersSent && !response.destroyed)
      reply(response, error.status || 500, {
        error: error.status ? error.message : '서버에서 요청을 처리할 수 없습니다.',
        ...(error.code === 'stt_provider_changed' ? { code: error.code } : {}),
      });
  });
};
const useTLS = process.env.TLS_CERT_FILE || process.env.TLS_KEY_FILE;
const server = useTLS
  ? https.createServer(
      { cert: await readFile(process.env.TLS_CERT_FILE), key: await readFile(process.env.TLS_KEY_FILE) },
      handler,
    )
  : http.createServer(handler);
const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws' || !sameOrigin(req)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

wss.on('connection', (socket) => {
  let connection,
    joining = false,
    renewIce;
  let windowStart = Date.now(),
    messages = 0;
  socket.alive = true;
  socket.on('pong', () => {
    socket.alive = true;
  });
  const timeout = setTimeout(() => socket.close(1008, 'Join required'), 10000);
  socket.on('error', () => socket.terminate());
  socket.on('close', () => {
    clearTimeout(timeout);
    clearInterval(renewIce);
    if (connection) removeConnection(connection.room, connection.id, socket);
  });
  socket.on('message', async (bytes, binary) => {
    try {
      if (Date.now() - windowStart > 10000) {
        windowStart = Date.now();
        messages = 0;
      }
      if (++messages > 500 || binary) throw fail(400, '잘못된 연결 요청입니다.');
      const msg = JSON.parse(bytes);
      if (!connection) {
        if (joining || msg.type !== 'join' || !validId(msg.roomId))
          throw fail(400, '먼저 회의에 입장해 주세요.');
        joining = true;
        const room = await loadRoom(msg.roomId);
        const { id, name } = identity(room, msg.token);
        if (socket.readyState !== WebSocket.OPEN) return;
        const old = room.live.get(id);
        if (!old && room.live.size >= maxSeats) throw fail(409, '회의 정원 8명이 모두 참석 중입니다.');
        if (old) {
          removeConnection(room, id, old.socket);
          old.socket.close(4001, 'Session resumed elsewhere');
        }
        const participant = {
          id,
          name,
          mic: msg.mic === true,
          camera: msg.camera === true,
          transcribing: msg.transcribing === true,
        };
        room.live.set(id, { socket, participant });
        connection = { room, id };
        clearTimeout(timeout);
        send(socket, {
          type: 'welcome',
          ...info(room),
          selfId: id,
          ...iceConfig(id),
          participants: [...room.live.values()].map((p) => p.participant),
          transcript: history(room),
        });
        if (turn) {
          // Renew from the server so a background tab does not depend on a precise JS timer.
          renewIce = setInterval(() => {
            if (room.live.get(id)?.socket === socket) {
              send(socket, { type: 'ice-config', ...iceConfig(id) });
            }
          }, turn.ttl * 700);
        }
        broadcast(room, { type: 'peer-joined', participant }, id);
        return;
      }
      const { room, id } = connection;
      const live = room.live.get(id);
      if (live?.socket !== socket) return;
      if (msg.type === 'state') {
        for (const key of ['mic', 'camera', 'transcribing']) {
          if (typeof msg[key] === 'boolean') live.participant[key] = msg[key];
        }
        broadcast(room, { type: 'peer-state', participant: live.participant });
      } else if (
        msg.type === 'signal' &&
        msg.to !== id &&
        msg.signal &&
        typeof msg.signal === 'object'
      ) {
        const peer = room.live.get(msg.to);
        if (peer) send(peer.socket, { type: 'signal', from: id, signal: msg.signal });
      }
    } catch (error) {
      send(socket, {
        type: 'error',
        error: error.status ? error.message : '연결 요청을 확인해 주세요.',
        status: error.status || 400,
      });
      socket.close(1008, 'Invalid request');
    }
  });
});

const maintenance = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.alive) {
      socket.terminate();
      continue;
    }
    socket.alive = false;
    socket.ping();
  }
  for (const [id, room] of rooms) {
    if (!room.live.size && !room.pending.size && Date.now() - room.touched > 15 * 60 * 1000)
      rooms.delete(id);
  }
}, 30000);
maintenance.unref();
const port = Number(process.env.PORT || 4317);
server.listen(port, process.env.HOST || '0.0.0.0', () => {
  console.log('Atlas Meet: ' + (useTLS ? 'https' : 'http') + '://localhost:' + server.address().port);
});
