import { Meeting, createRoom, getRoomInfo, inviteUrl, roomFromUrl, transcriptionReady } from './meeting.js';
import { hydrateIcons, icon, mountCover } from './visuals.js';

const $ = (id) => document.getElementById(id);
const el = (tag, text, css) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (css) node.className = css;
  return node;
};
const dates = {
  today: new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' }),
  meeting: new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }),
  speech: new Intl.DateTimeFormat('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }),
};
const localHistory = 'atlas-meet.recent.v1';
function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function saveStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
function readRooms() {
  try {
    return (JSON.parse(readStorage(localHistory)) || []).filter(
      (r) => /^[0-9a-f]{32}$/.test(r.id) && typeof r.title === 'string' && Number.isFinite(r.visited),
    );
  } catch {
    return [];
  }
}
function remember(id, title) {
  const rooms = readRooms().filter((r) => r.id !== id);
  rooms.unshift({ id, title, visited: Date.now() });
  saveStorage(localHistory, JSON.stringify(rooms.slice(0, 100)));
}
let toastTimer;
function notify(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('toast').hidden = true;
  }, 6500);
}
function empty(title, detail, glyph = 'history') {
  const item = el('div', undefined, 'list-empty');
  const badge = el('span', undefined, 'list-icon');
  badge.append(icon(glyph));
  const labels = el('div');
  labels.append(el('strong', title), el('p', detail));
  item.append(badge, labels);
  return item;
}
function drawRooms() {
  const rooms = readRooms();
  function render(target, rows, filtered = false) {
    target.replaceChildren();
    if (!rows.length) {
      target.append(
        filtered
          ? empty('검색 결과가 없습니다', '다른 회의 이름으로 검색해 보세요.', 'search')
          : empty('참여한 회의가 없습니다', '회의에 참여하면 이곳에서 발언 기록을 다시 볼 수 있습니다.'),
      );
      return;
    }
    for (const room of rows) {
      const btn = el('button', undefined, 'history-row');
      btn.type = 'button';
      const badge = el('span', undefined, 'list-icon');
      badge.append(icon('text'));
      const title = el('span');
      title.append(el('strong', room.title), el('small', dates.meeting.format(room.visited)));
      btn.append(badge, title, icon('chevron'));
      btn.addEventListener('click', () => navigate('#record/' + room.id));
      target.append(btn);
    }
  }
  const query = $('history-query').value.trim().toLocaleLowerCase();
  render($('recent-list'), rooms.slice(0, 3));
  render(
    $('history-list'),
    rooms.filter((r) => r.title.toLocaleLowerCase().includes(query)),
    Boolean(query),
  );
}
let archiveData = null,
  archiveRequest = 0;
function entryNode(entry, fullDates = false) {
  const row = el('article', undefined, 'entry');
  const header = el('div', undefined, 'entry-head'),
    at = new Date(entry.at);
  const time = el('time', (fullDates ? dates.meeting : dates.speech).format(at));
  time.dateTime = at.toISOString();
  header.append(el('strong', entry.speakerName), time);
  row.append(header, el('p', entry.text));
  return row;
}
function exportText(title, entries) {
  if (!entries.length) return;
  const lines = entries.map(
    (e) => '[' + new Date(e.at).toLocaleString('ko-KR') + '] ' + e.speakerName + '\n' + e.text,
  );
  const blob = new Blob(['\uFEFF' + title + '\n\n' + lines.join('\n\n') + '\n'], {
    type: 'text/plain;charset=utf-8',
  });
  const url = URL.createObjectURL(blob),
    a = el('a');
  a.href = url;
  a.download = (title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 70) || '회의') + ' 전사.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
async function showArchive(id) {
  const version = ++archiveRequest;
  archiveData = { id, title: '회의 기록', transcript: [] };
  $('archive-title').textContent = readRooms().find((r) => r.id === id)?.title || '회의 기록';
  $('archive-desc').textContent = '발언 기록을 불러오는 중입니다.';
  $('archive-entries').replaceChildren();
  $('archive-export').disabled = true;
  $('archive-join').disabled = true;
  try {
    const res = await fetch('/api/rooms/' + id + '/transcript', { cache: 'no-store' });
    if (!res.ok)
      throw new Error(
        res.status === 404 ? '이 회의를 찾을 수 없습니다.' : '회의 기록을 불러오지 못했습니다.',
      );
    const data = await res.json();
    if (version !== archiveRequest) return;
    const entries = data.transcript
      .slice()
      .sort((a, b) => +new Date(a.at) - new Date(b.at) || a.id.localeCompare(b.id));
    archiveData = { id, title: data.title, transcript: entries };
    $('archive-title').textContent = data.title;
    $('archive-desc').textContent =
      dates.meeting.format(new Date(data.createdAt)) + ' 개설 · 발언 ' + entries.length + '개';
    $('archive-join').disabled = false;
    $('archive-export').disabled = entries.length === 0;
    if (entries.length) {
      const fragment = document.createDocumentFragment();
      for (const e of entries) fragment.append(entryNode(e, true));
      $('archive-entries').append(fragment);
    } else
      $('archive-entries').append(
        logEmpty(
          '아직 전사된 발언이 없습니다',
          '회의에서 마이크와 내 발언 전사를 켜면 이곳에 기록됩니다.',
        ),
      );
  } catch (error) {
    if (version !== archiveRequest) return;
    $('archive-desc').textContent = '회의 기록을 열 수 없습니다.';
    const retry = el('button', '다시 시도', 'secondary');
    retry.type = 'button';
    retry.onclick = () => showArchive(id);
    $('archive-entries').append(logEmpty('기록을 불러오지 못했습니다', error.message), retry);
  }
}
function logEmpty(title, detail) {
  const wrap = el('div', undefined, 'log-empty');
  wrap.append(icon('text'), el('strong', title), el('p', detail));
  return wrap;
}
let view = 'lobby',
  mode = 'create',
  busy = false,
  meeting = null,
  leaving = false,
  callStart = 0,
  clockTimer;
let preview = null,
  meterContext = null,
  meterFrame = 0,
  previewVersion = 0,
  lookup = 0;
let roomCreationRequiresKey = false;
let lobbyTranscription = null;
const devicePending = new Set();
function setView(page) {
  view = page;
  for (const name of ['lobby', 'history-page', 'archive', 'room']) $(name).hidden = name !== page;
  $('navigation').hidden = page === 'room';
  for (const [id, active] of [
    ['nav-home', page === 'lobby'],
    ['nav-history', page === 'history-page' || page === 'archive'],
  ])
    if (active) $(id).setAttribute('aria-current', 'page');
    else $(id).removeAttribute('aria-current');
  document.title =
    { lobby: '회의실', 'history-page': '회의 기록', archive: '전사 기록', room: '회의 중' }[page] +
    ' · Atlas Meet';
}
function navigate(hash) {
  if (meeting || busy) return;
  history.pushState(null, '', location.pathname + hash);
  applyLocation();
  window.scrollTo(0, 0);
}
function applyLocation() {
  if (meeting || busy) return;
  const record = location.hash.match(/^#record\/([a-f0-9]{32})$/);
  if (record || location.hash === '#history') {
    stopPreview();
    setView(record ? 'archive' : 'history-page');
    if (record) showArchive(record[1]);
    else drawRooms();
  } else {
    setView('lobby');
    drawRooms();
    const invite = new URL(location.href).searchParams.get('room');
    if (invite !== null) {
      setMode('join');
      $('room-invite').value = invite;
      lookupInvite();
    } else {
      setMode('create');
    }
    checkServerStatus();
  }
}
function updateKeyField() {
  const visible = mode === 'create' && roomCreationRequiresKey;
  $('room-key-field').hidden = !visible;
  $('room-key').required = visible;
  if (!visible) $('room-key').value = '';
}
function setMode(value) {
  mode = value;
  updateKeyField();
  $('title-field').hidden = value !== 'create';
  $('invite-field').hidden = value !== 'join';
  $('room-invite').required = value === 'join';
  $('mode-create').setAttribute('aria-pressed', value === 'create');
  $('mode-join').setAttribute('aria-pressed', value === 'join');
  $('enter').querySelector('span').textContent = value === 'create' ? '회의 만들기' : '회의 참여하기';
  $('form-error').hidden = true;
}
async function lookupInvite() {
  const version = ++lookup;
  const value = $('room-invite').value.trim(),
    id = value && roomFromUrl(value);
  $('invite-detail').hidden = true;
  if (!id) return;
  try {
    const room = await getRoomInfo(id);
    if (version === lookup) {
      $('invite-detail').textContent = room.title;
      $('invite-detail').hidden = false;
    }
  } catch {
    if (version === lookup) {
      $('invite-detail').textContent = '초대 링크와 회의 코드를 확인해 주세요.';
      $('invite-detail').hidden = false;
    }
  }
}
function engineLabel(status) {
  if (status?.provider === 'openai') return 'OpenAI · ' + status.model;
  if (status?.provider === 'local' && status.model)
    return '로컬 · ' + status.model.replace(/^ggml-/, '').replace(/\.bin$/, '');
  return '전사 모델 미확인';
}
function cloudDisclosure(status) {
  return '전사를 켜면 내 마이크 음성이 OpenAI로 전송됩니다. 사용 모델은 ' + status.model + '입니다.';
}
async function checkServerStatus() {
  try {
    const r = await fetch('/api/status', { cache: 'no-store' });
    if (!r.ok) throw new Error();
    const status = await r.json();
    const { transcription } = status;
    roomCreationRequiresKey = status.roomCreationRequiresKey === true;
    updateKeyField();
    const ready = transcriptionReady(transcription);
    if (!ready || transcription.provider !== lobbyTranscription?.provider ||
        transcription.model !== lobbyTranscription?.model) $('speech-opt').checked = false;
    lobbyTranscription = transcription;
    $('speech-opt').disabled = busy || !ready;
    const description = transcription?.provider === 'openai'
      ? cloudDisclosure(transcription)
      : engineLabel(transcription);
    $('speech-help').textContent = ready
      ? description + ' 초대 링크로 전사 기록을 볼 수 있습니다.'
      : engineLabel(transcription) + ' · ' + (transcription?.detail || '전사 설정을 확인해 주세요.');
  } catch {
    lobbyTranscription = null;
    $('speech-opt').checked = false;
    $('speech-opt').disabled = true;
    $('speech-help').textContent = '전사 서버에 연결할 수 없습니다.';
  }
}
const tracks = (kind) =>
  preview?.getTracks().filter((t) => t.kind === kind && t.readyState === 'live') || [];
function deviceButton(button, active, glyph, offGlyph, label, showState) {
  button.setAttribute('aria-pressed', active);
  button.setAttribute('aria-label', label + (active ? ' 끄기' : ' 켜기'));
  const glyphName = active ? glyph : offGlyph;
  if (button.firstElementChild?.dataset.i !== glyphName)
    button.firstElementChild.replaceWith(icon(glyphName));
  if (showState) button.querySelector('span').textContent = label + (active ? ' 켜짐' : ' 꺼짐');
}
function refreshPreview() {
  const audio = Boolean(tracks('audio').length),
    video = Boolean(tracks('video').length);
  deviceButton($('preview-mic'), audio, 'mic', 'mic-off', '마이크', true);
  deviceButton($('preview-camera'), video, 'video', 'camera-off', '카메라', true);
  $('preview-video').hidden = !video;
  if ($('preview-video').srcObject !== (video ? preview : null))
    $('preview-video').srcObject = video ? preview : null;
  $('preview-caption').textContent = video ? '카메라가 켜져 있습니다' : '카메라가 꺼져 있습니다';
}
function stopMeter() {
  cancelAnimationFrame(meterFrame);
  meterContext?.close().catch(() => {});
  meterContext = null;
  for (const bar of $('meter').children) bar.classList.remove('lit');
}
async function startMeter(stream) {
  stopMeter();
  try {
    const ctx = new AudioContext();
    meterContext = ctx;
    const input = ctx.createMediaStreamSource(stream),
      analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    input.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    await ctx.resume();
    function frame() {
      if (meterContext !== ctx) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const n of data) sum += ((n - 128) / 128) ** 2;
      const level = Math.min(7, Math.round(Math.sqrt(sum / data.length) * 35));
      Array.from($('meter').children).forEach((b, i) => b.classList.toggle('lit', i < level));
      meterFrame = requestAnimationFrame(frame);
    }
    frame();
  } catch {
    stopMeter();
  }
}
function stopPreview() {
  previewVersion++;
  stopMeter();
  for (const t of preview?.getTracks() || []) {
    t.onended = null;
    t.stop();
  }
  preview = null;
  refreshPreview();
}
async function togglePreview(kind) {
  if (busy || devicePending.has(kind)) return;
  const button = $(kind === 'audio' ? 'preview-mic' : 'preview-camera');
  devicePending.add(kind);
  button.disabled = true;
  $('enter').disabled = true;
  const version = previewVersion;
  try {
    const current = tracks(kind);
    if (current.length) {
      for (const t of current) {
        t.stop();
        preview.removeTrack(t);
      }
      if (kind === 'audio') stopMeter();
    } else {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error('장치를 사용하려면 HTTPS 또는 localhost 주소에서 열어 주세요.');
      const media = await navigator.mediaDevices.getUserMedia({
        [kind]:
          kind === 'audio'
            ? { echoCancellation: true, noiseSuppression: true }
            : { width: { ideal: 960 }, height: { ideal: 540 } },
      });
      if (version !== previewVersion || view !== 'lobby') {
        media.getTracks().forEach((t) => t.stop());
        return;
      }
      if (!preview) preview = new MediaStream();
      for (const t of media.getTracks()) {
        preview.addTrack(t);
        t.onended = () => {
          if (kind === 'audio') stopMeter();
          refreshPreview();
        };
      }
      if (kind === 'audio') startMeter(media);
    }
  } catch (error) {
    const name = kind === 'audio' ? '마이크' : '카메라';
    notify(
      error.name === 'NotAllowedError'
        ? name + ' 권한을 브라우저에서 허용해 주세요.'
        : error.name === 'NotFoundError'
          ? name + '를 찾을 수 없습니다. 장치 연결을 확인해 주세요.'
          : error.message,
    );
  } finally {
    devicePending.delete(kind);
    button.disabled = busy;
    $('enter').disabled = busy || devicePending.size > 0;
    refreshPreview();
  }
}
function setBusy(value) {
  busy = value;
  $('speech-opt').disabled = value || !transcriptionReady(lobbyTranscription);
  for (const id of [
    'enter',
    'mode-create',
    'mode-join',
    'preview-camera',
    'preview-mic',
    'display-name',
    'room-title',
    'room-key',
    'room-invite',
  ])
    $(id).disabled = value;
  $('enter').querySelector('span').textContent = value
    ? '입장 중…'
    : mode === 'create'
      ? '회의 만들기'
      : '회의 참여하기';
}
async function enterMeeting(event) {
  event.preventDefault();
  if (busy || meeting || devicePending.size) return;
  const name = $('display-name').value.trim(),
    title = $('room-title').value.trim() || '팀 회의';
  const input = $('room-invite').value.trim();
  let id = mode === 'join' && input ? roomFromUrl(input) : '';
  $('form-error').hidden = true;
  if (!name || (mode === 'join' && !id)) {
    formError(
      !name ? '표시할 이름을 입력해 주세요.' : '올바른 초대 링크 또는 32자리 회의 코드를 입력해 주세요.',
    );
    return;
  }
  const selectedEngine = $('speech-opt').checked ? lobbyTranscription : null;
  setBusy(true);
  try {
    if (mode === 'create') {
      id = await createRoom(title, $('room-key').value.trim());
      // Keep the new invitation if a later connection step fails.
      history.replaceState(null, '', inviteUrl(id));
      $('room-invite').value = id;
      setMode('join');
    }
    const call = new Meeting({
      onChange: (state) => {
        if (meeting === call && view === 'room') renderCall(state);
      },
      onNotice: notify,
    });
    meeting = call;
    const mic = !!tracks('audio').length,
      camera = !!tracks('video').length;
    stopMeter();
    await call.join({
      roomId: id,
      name,
      mic,
      camera,
      transcribe: Boolean(selectedEngine),
      approveTranscription: (status) => {
        if (status.provider !== selectedEngine.provider || status.model !== selectedEngine.model)
          throw new Error('입장하는 동안 전사 모델이 바뀌었습니다. 회의에서 내 발언 전사를 다시 켜 주세요.');
        return true;
      },
      stream: preview || undefined,
    });
    preview = null;
    refreshPreview();
    saveStorage('atlas-meet.name', name);
    remember(id, call.state.title);
    history.replaceState(null, '', inviteUrl(id));
    callStart = Date.now();
    setView('room');
    selectPanel('transcript');
    renderCall(call.state);
    tickClock();
    clockTimer = setInterval(tickClock, 1000);
    window.scrollTo(0, 0);
  } catch (error) {
    if (meeting) stopPreview();
    meeting = null;
    if (mode === 'create' && error.status === 403) await checkServerStatus();
    formError(error.message);
  } finally {
    setBusy(false);
  }
}
function formError(detail) {
  $('form-error').textContent = detail;
  $('form-error').hidden = false;
}
function tickClock() {
  const secs = Math.floor((Date.now() - callStart) / 1000);
  $('duration').textContent =
    String(Math.floor(secs / 60)).padStart(2, '0') + ':' + String(secs % 60).padStart(2, '0');
}
const tiles = new Map(),
  blockedAudio = new Set();
function playAudio(audio) {
  audio
    .play()
    .then(() => {
      blockedAudio.delete(audio);
      $('enable-sound').hidden = !blockedAudio.size;
    })
    .catch((err) => {
      if (err.name === 'NotAllowedError' && audio.isConnected) {
        blockedAudio.add(audio);
        $('enable-sound').hidden = false;
      }
    });
}
function updateTiles(people) {
  const present = new Set(people.map((p) => p.id));
  for (const [id, tile] of tiles)
    if (!present.has(id)) {
      blockedAudio.delete(tile.audio);
      tile.audio.srcObject = null;
      tile.video.srcObject = null;
      tile.root.remove();
      tiles.delete(id);
    }
  for (const p of people) {
    let tile = tiles.get(p.id);
    if (!tile) {
      const root = el('div', undefined, 'tile' + (p.local ? ' local' : '')),
        avatar = el('span', undefined, 'avatar');
      const video = el('video');
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true;
      const audio = el('audio');
      audio.autoplay = true;
      const name = el('span', undefined, 'tile-name');
      name.append(icon('mic-off'), el('span'));
      root.append(avatar, video, audio, name);
      $('tiles').append(root);
      tile = { root, avatar, video, audio, name };
      tiles.set(p.id, tile);
    }
    const { video, audio, avatar, name } = tile;
    const videoTrack = p.stream?.getVideoTracks().find((t) => t.readyState === 'live');
    if (videoTrack && video.srcObject?.getVideoTracks()[0] !== videoTrack)
      video.srcObject = new MediaStream([videoTrack]);
    if (!videoTrack && video.srcObject) video.srcObject = null;
    video.hidden = !p.camera || !videoTrack;
    const audioTrack = !p.local && p.stream?.getAudioTracks().find((t) => t.readyState === 'live');
    if (audioTrack && audio.srcObject?.getAudioTracks()[0] !== audioTrack) {
      audio.srcObject = new MediaStream([audioTrack]);
      playAudio(audio);
    }
    if (!audioTrack && audio.srcObject) {
      blockedAudio.delete(audio);
      audio.srcObject = null;
    }
    avatar.textContent = Array.from(p.name)[0] || '·';
    name.lastElementChild.textContent = p.name + (p.local ? ' (나)' : '');
    const glyph = p.mic ? 'mic' : 'mic-off';
    if (name.firstElementChild.dataset.i !== glyph) name.firstElementChild.replaceWith(icon(glyph));
  }
  $('enable-sound').hidden = !blockedAudio.size;
}
let previousLog = null;
function renderLog(entries) {
  if (entries === previousLog) return;
  const parent = $('live-entries'),
    follow = parent.scrollHeight - parent.scrollTop - parent.clientHeight < 75;
  if (!entries.length)
    parent.replaceChildren(
      logEmpty(
        '발언을 기다리고 있습니다',
        '마이크와 내 발언 전사를 켠 참석자가 말하면 이름과 함께 표시됩니다.',
      ),
    );
  else if (
    previousLog?.length &&
    entries.length === previousLog.length + 1 &&
    entries.at(-2).id === previousLog.at(-1).id
  )
    parent.append(entryNode(entries.at(-1)));
  else {
    const fragment = document.createDocumentFragment();
    for (const e of entries) fragment.append(entryNode(e));
    parent.replaceChildren(fragment);
  }
  previousLog = entries;
  if (follow) parent.scrollTop = parent.scrollHeight;
}
function renderCall(state) {
  const self = state.participants.find((p) => p.local);
  $('meeting-name').textContent = state.title || '팀 회의';
  $('connection').textContent = leaving
    ? '마지막 발언을 저장하는 중'
    : {
        connected: '회의 중',
        connecting: '연결 중',
        reconnecting: '다시 연결하는 중',
        disconnected: '연결 종료',
      }[state.connection] || '연결 중';
  $('connection').parentNode.classList.toggle('online', state.connection === 'connected');
  $('people-count').textContent = state.participants.length;
  updateTiles(state.participants);
  deviceButton($('call-mic'), Boolean(self?.mic), 'mic', 'mic-off', '마이크', false);
  deviceButton($('call-camera'), Boolean(self?.camera), 'video', 'camera-off', '카메라', false);
  $('call-engine').textContent = engineLabel(state.transcription);
  $('call-speech').setAttribute('aria-pressed', state.transcribing);
  $('call-speech').setAttribute(
    'aria-label',
    state.transcribing ? '내 발언 전사 끄기' : '내 발언 전사 켜기',
  );
  $('call-speech').title = state.transcribing
    ? self?.mic
      ? '내 발언 전사 중'
      : '마이크를 켜면 내 발언을 전사합니다'
    : '내 발언을 한국어로 기록합니다';
  for (const id of ['call-speech', 'call-mic', 'call-camera']) {
    const canSwitchOff =
      state.connection === 'reconnecting' && $(id).getAttribute('aria-pressed') === 'true';
    $(id).disabled =
      leaving || devicePending.has(id) || (state.connection !== 'connected' && !canSwitchOff);
  }
  renderLog(state.transcripts);
  $('live-export').disabled = !state.transcripts.length;
  const persons = state.participants.map((p) => {
    const row = el('div', undefined, 'person');
    row.append(el('span', Array.from(p.name)[0], 'avatar'));
    const detail = el('span', p.name + (p.local ? ' (나)' : ''));
    detail.append(
      el(
        'small',
        (p.mic ? '마이크 켜짐' : '음소거') + ' · ' + (p.transcribing ? '전사 켜짐' : '전사 꺼짐'),
      ),
    );
    row.append(detail);
    return row;
  });
  $('people-list').replaceChildren(...persons);
}
function selectPanel(panel) {
  for (const [value, id] of [
    ['transcript', 'panel-transcript'],
    ['people', 'panel-people'],
  ])
    $(id).setAttribute('aria-pressed', panel === value);
  $('live-entries').hidden = panel !== 'transcript';
  $('people-list').hidden = panel !== 'people';
}
async function callAction(id, method) {
  const call = meeting,
    button = $(id);
  if (!call || devicePending.has(id) || leaving) return;
  const enabled = button.getAttribute('aria-pressed') !== 'true';
  devicePending.add(id);
  button.disabled = true;
  try {
    if (method === 'setTranscription') {
      await call.setTranscription(enabled, (status) => status.provider === 'local' ||
        window.confirm(cloudDisclosure(status) + '\n내 발언 전사를 켤까요?'));
      if (call.state.transcribing && !call.state.participants.find((p) => p.local)?.mic)
        notify('마이크를 켜면 내 발언을 전사합니다.');
    } else {
      await call[method](enabled);
    }
  } catch (error) {
    notify(error.message);
  } finally {
    devicePending.delete(id);
    if (call === meeting) renderCall(call.state);
  }
}
async function leaveMeeting() {
  const call = meeting;
  if (!call || leaving) return;
  leaving = true;
  $('leave').disabled = true;
  renderCall(call.state);
  const id = call.state.roomId,
    title = call.state.title;
  try {
    await call.leave();
  } catch (error) {
    notify(error.message);
  }
  clearInterval(clockTimer);
  updateTiles([]);
  previousLog = null;
  meeting = null;
  leaving = false;
  $('leave').disabled = false;
  $('speech-opt').checked = false;
  remember(id, title);
  history.replaceState(null, '', location.pathname + '#record/' + id);
  applyLocation();
  window.scrollTo(0, 0);
}
async function copyInvite() {
  if (!meeting) return;
  const url = inviteUrl(meeting.state.roomId);
  try {
    await navigator.clipboard.writeText(url);
    notify('초대 링크를 복사했습니다.');
  } catch {
    $('invite-copy').value = url;
    $('invite-dialog').showModal();
    $('invite-copy').select();
  }
}

hydrateIcons();
mountCover($('cover'));
const now = new Date();
$('today').textContent = dates.today.format(now);
$('today').dateTime = now.toLocaleDateString('sv-SE');
$('display-name').value = readStorage('atlas-meet.name') || '';
$('nav-home').onclick = () => navigate('');
$('nav-history').onclick =
  $('all-history').onclick =
  $('back-history').onclick =
    () => navigate('#history');
$('brand').onclick = (e) => {
  e.preventDefault();
  if (view === 'room') notify('회의를 마치려면 나가기를 눌러 주세요.');
  else navigate('');
};
$('mode-create').onclick = () => setMode('create');
$('mode-join').onclick = () => setMode('join');
$('room-invite').oninput = lookupInvite;
$('history-query').oninput = drawRooms;
$('entry-form').onsubmit = enterMeeting;
$('preview-mic').onclick = () => togglePreview('audio');
$('preview-camera').onclick = () => togglePreview('video');
$('archive-join').onclick = () => {
  if (!archiveData) return;
  history.pushState(null, '', inviteUrl(archiveData.id));
  applyLocation();
};
$('archive-export').onclick = () => {
  if (archiveData) exportText(archiveData.title, archiveData.transcript);
};
$('panel-transcript').onclick = () => selectPanel('transcript');
$('panel-people').onclick = () => selectPanel('people');
$('call-mic').onclick = () => callAction('call-mic', 'setMic');
$('call-camera').onclick = () => callAction('call-camera', 'setCamera');
$('call-speech').onclick = () => callAction('call-speech', 'setTranscription');
$('leave').onclick = leaveMeeting;
$('copy-invite').onclick = copyInvite;
$('live-export').onclick = () => {
  if (meeting) exportText(meeting.state.title, meeting.state.transcripts);
};
$('enable-sound').onclick = () => {
  for (const audio of blockedAudio) playAudio(audio);
};
window.addEventListener('popstate', () => {
  if (meeting) history.replaceState(null, '', inviteUrl(meeting.state.roomId));
  else applyLocation();
});
window.addEventListener('storage', (e) => {
  if (e.key === localHistory) drawRooms();
});
window.addEventListener('pagehide', () => {
  stopPreview();
  if (meeting) meeting.leave().catch(() => {});
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) location.reload();
});
applyLocation();
