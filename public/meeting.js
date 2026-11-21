import { startSpeechCapture } from './speech.js';

const deviceLabels = { audio: '마이크', video: '카메라' };
const mediaConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  video: { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 24 } },
};

function deviceError(kind, error) {
  const label = deviceLabels[kind];
  if (error.name === 'NotAllowedError')
    return new Error(`브라우저의 사이트 설정에서 ${label} 사용을 허용해 주세요.`);
  if (error.name === 'NotFoundError')
    return new Error(`${label}를 찾을 수 없습니다. 장치 연결을 확인해 주세요.`);
  return new Error(`${label}를 열 수 없습니다. 장치가 다른 앱에서 사용 중인지 확인해 주세요.`);
}

async function request(path, options, timeout = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let response, body;
  try {
    response = await fetch(path, { cache: 'no-store', ...options, signal: controller.signal });
    body = await response.json();
  } catch {
    throw new Error('회의 서버에 연결할 수 없습니다. 네트워크 연결을 확인해 주세요.');
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const error = new Error(
      typeof body.error === 'string'
        ? body.error
        : '회의 요청을 처리하지 못했습니다. 다시 시도해 주세요.',
    );
    error.status = response.status;
    error.code = body.code;
    throw error;
  }
  return body;
}

function postJson(path, value, headers = {}) {
  return request(path, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
}

function roomPath(roomId) {
  return '/api/rooms/' + encodeURIComponent(roomId);
}

export async function createRoom(title, roomKey = '') {
  const headers = roomKey ? { 'X-Atlas-Room-Key': roomKey } : {};
  const { roomId } = await postJson('/api/rooms', { title }, headers);
  return roomId;
}

export function getRoomInfo(roomId) {
  return request(roomPath(roomId));
}

export function inviteUrl(roomId) {
  const url = new URL('/', location.origin);
  url.searchParams.set('room', roomId);
  return url.href;
}

export function roomFromUrl(value = location.href) {
  try {
    const input = String(value).trim();
    const code = /^[a-f0-9]{32}$/i;
    const roomId = code.test(input)
      ? input
      : new URL(input, location.href).searchParams.get('room') || '';
    return code.test(roomId) ? roomId.toLowerCase() : '';
  } catch {
    return '';
  }
}

export function transcriptionReady(status) {
  return status?.available === true && ['openai', 'local'].includes(status.provider) &&
    typeof status.model === 'string' && status.model.trim() !== '';
}

function emptyState() {
  return {
    roomId: '',
    title: '',
    selfId: '',
    connection: 'idle',
    participants: [],
    transcripts: [],
    transcribing: false,
    transcription: null,
  };
}

function normalizeEntry(entry) {
  return { ...entry, at: new Date(entry.at).getTime() };
}

function chronological(a, b) {
  return a.at - b.at || a.id.localeCompare(b.id);
}

export class Meeting {
  constructor({ onChange = () => {}, onNotice = () => {} } = {}) {
    this.onChange = onChange;
    this.onNotice = onNotice;
    this.state = emptyState();
    this.session = null;
    this.peers = new Map();
    this.roster = new Map();
    this.serial = Promise.resolve();
  }

  refresh() {
    this.state.participants = [...this.roster.values()]
      .map((person) => {
        const local = person.id === this.state.selfId;
        return {
          ...person,
          local,
          stream: local ? this.session?.stream : this.peers.get(person.id)?.stream || null,
        };
      })
      .sort((a, b) => Number(b.local) - Number(a.local));
    this.onChange(this.state);
  }

  async join({ roomId, name, mic = false, camera = false, transcribe = false, approveTranscription, stream } = {}) {
    if (this.session) throw new Error('이미 회의에 연결 중입니다.');
    if (!window.RTCPeerConnection || !window.MediaStream) {
      throw new Error('화상 회의를 지원하는 브라우저에서 열어 주세요.');
    }
    const session = {
      roomId,
      name,
      stream: stream || new MediaStream(),
      token: '',
      ws: null,
      capture: null,
      drains: new Set(),
      transcribing: false,
      retry: 0,
      retryTimer: 0,
      iceServers: [],
    };
    this.session = session;
    this.state = { ...emptyState(), roomId, connection: 'connecting' };
    this.refresh();
    try {
      const [member, status] = await Promise.all([
        postJson(roomPath(roomId) + '/join', { name }),
        request('/api/status').catch(() => ({
          transcription: { available: false, detail: '전사 엔진 상태를 확인할 수 없습니다.' },
        })),
      ]);
      session.token = member.token;
      if (this.session !== session) {
        await this.releaseMembership(session);
        throw new Error('회의 입장을 취소했습니다.');
      }
      this.state.selfId = member.participantId;
      this.state.transcription = status.transcription;
      for (const [kind, enabled] of [
        ['audio', mic],
        ['video', camera],
      ]) {
        try {
          await this.changeDevice(session, kind, enabled);
        } catch (error) {
          if (this.session !== session) throw error;
          this.onNotice(error.message);
        }
      }
      await this.connect(session);
      if (transcribe) {
        try {
          await this.setTranscription(true, approveTranscription);
        } catch (error) {
          this.onNotice(error.message);
        }
      }
      return this.state;
    } catch (error) {
      if (this.session === session) await this.leave();
      throw error;
    }
  }

  mediaState(session) {
    const active = (kind) =>
      session.stream.getTracks().some((t) => t.kind === kind && t.enabled && t.readyState === 'live');
    return { mic: active('audio'), camera: active('video'), transcribing: session.transcribing };
  }

  send(session, message) {
    if (session.ws?.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify(message));
  }

  publishState(session) {
    if (this.session !== session) return;
    const media = this.mediaState(session);
    this.state.transcribing = media.transcribing;
    const self = this.roster.get(this.state.selfId);
    if (self) Object.assign(self, media);
    if (session.welcomed) this.send(session, { type: 'state', ...media });
    this.refresh();
  }

  connect(session) {
    return new Promise((resolve, reject) => {
      if (this.session !== session) return reject(new Error('회의 입장을 취소했습니다.'));
      const url = new URL('/ws', location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(url);
      session.ws = ws;
      session.welcomed = false;
      let welcome = false;
      let reason = '';
      const timer = setTimeout(() => ws.close(), 12000);
      ws.onopen = () =>
        this.send(session, {
          type: 'join',
          roomId: session.roomId,
          token: session.token,
          ...this.mediaState(session),
        });
      ws.onmessage = (event) => {
        if (session.ws !== ws || this.session !== session) return;
        let packet;
        try {
          packet = JSON.parse(event.data);
        } catch {
          return;
        }
        if (packet.type === 'welcome') {
          clearTimeout(timer);
          welcome = session.welcomed = true;
          session.retry = 0;
          session.iceServers = packet.iceServers || [];
          this.state.title = packet.title;
          this.state.selfId = packet.selfId;
          this.state.connection = 'connected';
          this.state.transcripts = packet.transcript.map(normalizeEntry).sort(chronological);
          this.roster = new Map(packet.participants.map((person) => [person.id, person]));
          for (const id of this.roster.keys()) this.addPeer(session, id);
          this.publishState(session);
          resolve();
        } else if (packet.type === 'ice-config') {
          session.iceServers = packet.iceServers;
          for (const peer of this.peers.values()) {
            this.queuePeer(session, peer, async () => {
              peer.pc.setConfiguration({
                ...peer.pc.getConfiguration(),
                iceServers: session.iceServers,
              });
              if (peer.offers) await this.offer(session, peer, true);
              else this.send(session, { type: 'signal', to: peer.id, signal: { restart: true } });
            });
          }
        } else if (packet.type === 'peer-joined') {
          this.dropPeer(packet.participant.id);
          this.roster.set(packet.participant.id, packet.participant);
          this.addPeer(session, packet.participant.id);
          this.refresh();
        } else if (packet.type === 'peer-left') {
          this.dropPeer(packet.id);
          this.roster.delete(packet.id);
          this.refresh();
        } else if (packet.type === 'peer-state') {
          this.roster.set(packet.participant.id, packet.participant);
          this.refresh();
        } else if (packet.type === 'signal') {
          const peer = this.peers.get(packet.from);
          if (peer)
            this.queuePeer(session, peer, () => this.receiveSignal(session, peer, packet.signal));
        } else if (packet.type === 'transcript') {
          this.appendEntry(packet.entry);
        } else if (packet.type === 'error') {
          reason = packet.message || packet.error || '회의 서버가 요청을 처리하지 못했습니다.';
          if (welcome) this.onNotice(reason);
          else ws.close();
        }
      };
      ws.onclose = (event) => {
        clearTimeout(timer);
        if (!welcome) reject(new Error(reason || '회의 연결이 끊겼습니다. 다시 시도해 주세요.'));
        if (this.session !== session || session.ws !== ws) return;
        session.welcomed = false;
        for (const id of this.peers.keys()) this.dropPeer(id);
        const self = this.roster.get(this.state.selfId);
        this.roster.clear();
        if (self) this.roster.set(self.id, self);
        if (event.code === 1008 || event.code === 4001 || event.code === 4003) {
          session.replaced = event.code === 4001;
          this.state.connection = 'disconnected';
          this.onNotice(reason || '회의 연결이 종료됐습니다. 초대 링크로 다시 입장해 주세요.');
          this.leave().catch(() => {});
        } else if (welcome) {
          this.scheduleReconnect(session);
        }
      };
    });
  }

  scheduleReconnect(session) {
    if (this.session !== session) return;
    this.state.connection = 'reconnecting';
    this.refresh();
    const delay = Math.min(12000, 600 * 2 ** Math.min(session.retry++, 5));
    session.retryTimer = setTimeout(() => {
      this.connect(session).catch(() => this.scheduleReconnect(session));
    }, delay);
  }

  appendEntry(entry) {
    if (!entry || this.state.transcripts.some((existing) => existing.id === entry.id)) return;
    this.state.transcripts = [...this.state.transcripts, normalizeEntry(entry)].sort(chronological);
    this.refresh();
  }

  enqueue(session, operation) {
    const result = this.serial.then(() => {
      if (session !== this.session || !session) throw new Error('회의에 먼저 입장해 주세요.');
      return operation();
    });
    this.serial = result.catch(() => {});
    return result;
  }

  setMic(enabled) {
    const session = this.session;
    return this.enqueue(session, () => this.changeDevice(session, 'audio', enabled));
  }

  setCamera(enabled) {
    const session = this.session;
    return this.enqueue(session, () => this.changeDevice(session, 'video', enabled));
  }

  async changeDevice(session, kind, enabled) {
    if (this.session !== session) throw new Error('회의 연결이 종료되었습니다.');
    let tracks = session.stream.getTracks().filter((track) => track.kind === kind);
    if (enabled && !tracks.some((track) => track.readyState === 'live')) {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error('카메라와 마이크를 사용하려면 HTTPS 또는 localhost 주소로 열어 주세요.');
      let media;
      try {
        media = await navigator.mediaDevices.getUserMedia({ [kind]: mediaConstraints[kind] });
      } catch (error) {
        throw deviceError(kind, error);
      }
      if (this.session !== session) {
        media.getTracks().forEach((track) => track.stop());
        throw new Error('회의 연결이 종료되었습니다.');
      }
      for (const track of tracks) session.stream.removeTrack(track);
      tracks = media.getTracks();
      for (const track of tracks) session.stream.addTrack(track);
    }
    for (const track of tracks) {
      if (enabled) {
        track.enabled = true;
        track.onended = () => {
          if (this.session !== session) return;
          this.enqueue(session, () => this.changeDevice(session, kind, false)).catch(() => {});
          this.onNotice(deviceLabels[kind] + ' 연결이 해제됐습니다.');
        };
      } else {
        track.enabled = false;
        track.onended = null;
        if (kind === 'audio') session.capture?.setMuted(true);
        track.stop();
        session.stream.removeTrack(track);
      }
    }
    this.publishState(session);
    const liveTrack = enabled ? tracks[0] : null;
    await Promise.all(
      [...this.peers.values()].map((peer) =>
        this.queuePeer(session, peer, async () => {
          const transceiver = peer.pc.getTransceivers().find((t) => t.receiver.track.kind === kind);
          if (transceiver) await transceiver.sender.replaceTrack(liveTrack || null);
        }),
      ),
    );
    if (kind === 'audio') await this.syncCapture(session);
  }

  setTranscription(enabled, approve) {
    const session = this.session;
    return this.enqueue(session, async () => {
      if (enabled) {
        const { transcription } = await request('/api/status');
        if (this.session !== session) return;
        this.state.transcription = transcription;
        this.refresh();
        if (!transcriptionReady(transcription)) {
          throw new Error(transcription?.detail || '서버의 전사 제공자와 모델 설정을 확인해 주세요.');
        }
        if (approve) {
          if (!approve(transcription)) return;
        } else if (transcription.provider === 'openai') {
          throw new Error('내 발언 전사를 켜고 OpenAI로 음성을 전송하는 데 동의해 주세요.');
        }
        session.captureRoute = { provider: transcription.provider, revoked: false };
      }
      session.transcribing = Boolean(enabled);
      this.publishState(session);
      await this.syncCapture(session);
    });
  }

  async syncCapture(session) {
    if (session !== this.session) return;
    if (session.transcribing && this.mediaState(session).mic) {
      if (session.capture) return;
      const route = session.captureRoute;
      try {
        const capture = await startSpeechCapture(session.stream, {
          onChunk: (wav, id, at) => this.uploadAudio(session, route, wav, id, at),
          onError: (error) => this.onNotice(error.message),
        });
        if (this.session === session && session.transcribing && !route.revoked)
          session.capture = capture;
        else await capture.stop({ flush: false });
      } catch (error) {
        session.transcribing = false;
        this.publishState(session);
        throw new Error(error.message || '마이크 전사를 시작할 수 없습니다.');
      }
    } else if (session.capture) {
      const capture = session.capture;
      session.capture = null;
      const drain = capture.stop().catch((error) => this.onNotice(error.message));
      session.drains.add(drain);
      drain.finally(() => session.drains.delete(drain));
    }
  }

  async uploadAudio(session, route, wav, id, at) {
    if (!route || !['local', 'openai'].includes(route.provider)) return;
    const options = {
      method: 'POST',
      body: wav,
      headers: {
        Authorization: 'Bearer ' + session.token,
        'Content-Type': 'audio/wav',
        'X-Atlas-STT-Provider': route.provider,
        'X-Chunk-Id': id,
        'X-Captured-At': String(at),
      },
    };
    for (let attempt = 0; ; attempt++) {
      if (route.revoked) return;
      try {
        const { entry } = await request(roomPath(session.roomId) + '/audio', options, 120000);
        if (this.session === session || (!this.session && this.state.roomId === session.roomId))
          this.appendEntry(entry);
        return;
      } catch (error) {
        if (error.code === 'stt_provider_changed') {
          route.revoked = true;
          if (this.session === session && session.captureRoute === route && session.transcribing) {
            session.transcribing = false;
            this.state.transcription = null;
            this.publishState(session);
            await this.syncCapture(session);
            this.onNotice(error.message);
          }
          return;
        }
        if (attempt >= 2 || (error.status && error.status < 500 && error.status !== 429)) {
          throw new Error('발언 한 구간의 전사를 저장하지 못했습니다. ' + error.message);
        }
        await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
      }
    }
  }

  queuePeer(session, peer, operation) {
    peer.queue = peer.queue
      .then(async () => {
        if (this.peers.get(peer.id) === peer) await operation();
      })
      .catch(() => {
        if (this.session === session && this.peers.get(peer.id) === peer) {
          this.onNotice('참석자와 미디어를 연결하지 못했습니다. 네트워크를 확인해 주세요.');
        }
      });
    return peer.queue;
  }

  addPeer(session, id) {
    if (id === this.state.selfId || this.peers.has(id)) return;
    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: session.iceServers });
    } catch {
      this.onNotice('미디어 연결을 시작할 수 없습니다. 회의 서버의 ICE 설정을 확인해 주세요.');
      return;
    }
    const peer = {
      id,
      pc,
      stream: new MediaStream(),
      queue: Promise.resolve(),
      candidates: [],
      offers: this.state.selfId < id,
    };
    this.peers.set(id, peer);
    pc.ontrack = ({ track }) => {
      peer.stream.addTrack(track);
      this.refresh();
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.send(session, { type: 'signal', to: id, signal: { candidate } });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') peer.restarted = false;
      if (pc.connectionState !== 'failed') return;
      if (peer.restarted) {
        this.onNotice(
          '다른 참석자와 미디어를 연결할 수 없습니다. 회의 서버의 TURN 설정을 확인해 주세요.',
        );
        return;
      }
      peer.restarted = true;
      if (peer.offers) this.queuePeer(session, peer, () => this.offer(session, peer, true));
      else this.send(session, { type: 'signal', to: id, signal: { restart: true } });
    };
    if (peer.offers) {
      for (const kind of ['audio', 'video']) {
        const track = session.stream.getTracks().find((t) => t.kind === kind);
        pc.addTransceiver(track || kind, { direction: 'sendrecv' });
      }
      this.queuePeer(session, peer, () => this.offer(session, peer));
    }
  }

  async offer(session, peer, restart = false) {
    if (peer.pc.signalingState !== 'stable') {
      if (restart) peer.restartPending = true;
      return;
    }
    peer.restartPending = false;
    await peer.pc.setLocalDescription(await peer.pc.createOffer({ iceRestart: restart }));
    this.send(session, {
      type: 'signal',
      to: peer.id,
      signal: { description: peer.pc.localDescription },
    });
  }

  async receiveSignal(session, peer, signal) {
    const pc = peer.pc;
    if (signal.restart && peer.offers) return this.offer(session, peer, true);
    if (signal.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(signal.candidate);
      else peer.candidates.push(signal.candidate);
    } else if (signal.description) {
      await pc.setRemoteDescription(signal.description);
      for (const candidate of peer.candidates.splice(0)) await pc.addIceCandidate(candidate);
      if (signal.description.type === 'offer') {
        for (const t of pc.getTransceivers()) {
          t.direction = 'sendrecv';
          const track = session.stream.getTracks().find((item) => item.kind === t.receiver.track.kind);
          await t.sender.replaceTrack(track || null);
        }
        await pc.setLocalDescription(await pc.createAnswer());
        this.send(session, {
          type: 'signal',
          to: peer.id,
          signal: { description: pc.localDescription },
        });
      } else if (peer.offers && peer.restartPending) {
        // A credential refresh may arrive before the previous offer has been answered.
        await this.offer(session, peer, true);
      }
    }
  }

  dropPeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    peer.pc.onconnectionstatechange = null;
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.close();
    for (const track of peer.stream.getTracks()) track.stop();
  }

  async releaseMembership(session) {
    if (session.token && !session.replaced) {
      await request(roomPath(session.roomId) + '/leave', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + session.token },
      }).catch(() => {});
    }
  }

  async leave() {
    const session = this.session;
    if (!session) return;
    this.session = null;
    clearTimeout(session.retryTimer);
    const drain = session.capture?.stop({ flush: !session.replaced });
    for (const track of session.stream.getTracks()) track.stop();
    for (const id of this.peers.keys()) this.dropPeer(id);
    session.ws?.close();
    this.roster.clear();
    this.state = { ...this.state, connection: 'disconnected', transcribing: false };
    this.refresh();
    try {
      await Promise.all([...session.drains, drain]);
    } finally {
      await this.releaseMembership(session);
    }
  }
}
