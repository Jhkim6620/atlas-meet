import { spawn } from 'node:child_process';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const engineDir = fileURLToPath(new URL('./.speech/', import.meta.url));
const executable = process.env.ATLAS_WHISPER_CLI || join(engineDir, 'whisper-cli');
const modelPath = process.env.ATLAS_WHISPER_MODEL || join(engineDir, 'ggml-whisper-large-v3-turbo-korean-q5_0.bin');
const vadModel = join(engineDir, 'ggml-silero-v5.1.2.bin');
const vadExecutable = join(engineDir, 'vad-speech-segments');
const qwenDir = join(engineDir, 'qwen3');
const qwenExecutable = join(qwenDir, 'crispasr');
const qwenFile = join(qwenDir, 'qwen3-asr-1.7b-q4_k.gguf');
const cloudModel = 'gpt-transcribe';
const defaultKeyFile = process.platform === 'darwin'
  ? join(homedir(), 'Library', 'Application Support', 'Atlas Meet', 'secrets', 'openai-api-key')
  : null;
const queuedLimit = 8;
let outstanding = 0;
let queue = Promise.resolve();

function speechError(status, message) {
  return Object.assign(new Error(message), { status });
}

function canUse(path, mode) {
  try {
    accessSync(path, mode);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function localConfig() {
  const selected = process.env.ATLAS_LOCAL_STT_ENGINE?.trim().toLowerCase();
  if (selected && selected !== 'qwen' && selected !== 'whisper')
    return { provider: 'local', model: null, available: false, detail: 'ATLAS_LOCAL_STT_ENGINE을 qwen 또는 whisper로 지정해 주세요.' };
  const supported = process.platform === 'darwin' && process.arch === 'arm64';
  const preferQwen = selected === 'qwen' || (!selected && supported &&
    !process.env.ATLAS_WHISPER_MODEL && !process.env.ATLAS_WHISPER_CLI && canUse(qwenFile, constants.R_OK));
  if (preferQwen) {
    const available = supported && canUse(qwenExecutable, constants.X_OK) && canUse(qwenFile, constants.R_OK) &&
      canUse(join(qwenDir, 'libc2pa_c.dylib'), constants.R_OK) && canUse(vadExecutable, constants.X_OK) && canUse(vadModel, constants.R_OK);
    return {
      provider: 'local', engine: 'qwen', model: 'Qwen3-ASR-1.7B', available,
      detail: available ? 'Qwen 한국어 전사 준비 완료' : 'Apple Silicon Mac 서버에서 sh scripts/setup-qwen.sh 명령으로 전사 모델을 설치해 주세요.',
    };
  }
  const available = canUse(executable, constants.X_OK) && canUse(modelPath, constants.R_OK) && canUse(vadModel, constants.R_OK);
  return {
    provider: 'local', model: basename(modelPath), available,
    detail: available ? '로컬 한국어 전사 준비 완료' : '서버에서 npm run setup:speech 명령으로 음성 인식 모델을 설치해 주세요.',
  };
}

function providerConfig() {
  const selected = process.env.ATLAS_STT_PROVIDER?.trim().toLowerCase();
  if (selected === 'local') return localConfig();
  if (selected && selected !== 'openai') {
    return { provider: 'unknown', model: null, available: false, detail: '서버의 ATLAS_STT_PROVIDER를 local 또는 openai로 지정해 주세요.' };
  }
  let key = process.env.OPENAI_API_KEY?.trim();
  const explicitFile = process.env.OPENAI_API_KEY_FILE?.trim();
  const keyFile = explicitFile || defaultKeyFile;
  let keyFilePresent = false;
  if (!key && keyFile) {
    try {
      const info = statSync(keyFile);
      keyFilePresent = true;
      if (info.isFile() && info.size <= 8192) key = readFileSync(keyFile, 'utf8').trim();
    } catch (error) {
      keyFilePresent = error.code !== 'ENOENT';
    }
  }
  if (!selected && !key && !explicitFile && !keyFilePresent) return localConfig();
  const profile = { provider: 'openai', model: cloudModel, available: false };
  if (!key || key.length > 8192 || !/^[!-~]+$/u.test(key))
    return { ...profile, detail: '서버에 유효한 OpenAI API 키를 설정해 주세요.' };
  if (!canUse(vadExecutable, constants.X_OK) || !canUse(vadModel, constants.R_OK))
    return { ...profile, detail: '서버에서 npm run setup:speech 명령으로 음성 감지기를 설치해 주세요.' };
  return { ...profile, available: true, detail: 'OpenAI 한국어 전사 설정 완료', key };
}

export function transcriptionStatus() {
  const { provider, model, available, detail } = providerConfig();
  return { provider, model, available, detail };
}

function validateAudio(wav) {
  const invalid = () => speechError(400, '16kHz 모노 16비트 PCM WAV 파일이 필요합니다.');
  if (
    !Buffer.isBuffer(wav) ||
    wav.length < 44 ||
    wav.length > 26 * 32000 + 4096 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE' ||
    wav.readUInt32LE(4) !== wav.length - 8
  )
    throw invalid();
  let pcm;
  let formatFound = false;
  for (let at = 12; at + 8 <= wav.length; ) {
    const label = wav.toString('ascii', at, at + 4);
    const length = wav.readUInt32LE(at + 4);
    const start = at + 8;
    const end = start + length;
    if (end > wav.length) throw invalid();
    if (label === 'fmt ') {
      if (
        formatFound ||
        length < 16 ||
        wav.readUInt16LE(start) !== 1 ||
        wav.readUInt16LE(start + 2) !== 1 ||
        wav.readUInt32LE(start + 4) !== 16000 ||
        wav.readUInt32LE(start + 8) !== 32000 ||
        wav.readUInt16LE(start + 12) !== 2 ||
        wav.readUInt16LE(start + 14) !== 16
      )
        throw invalid();
      formatFound = true;
    }
    if (label === 'data') {
      if (pcm || length % 2 !== 0 || length > 26 * 32000) throw invalid();
      pcm = wav.subarray(start, end);
    }
    at = end + (length % 2);
  }
  if (!formatFound || !pcm || pcm.length === 0) throw invalid();
  // Digital silence can otherwise produce fabricated text from a generative recognizer.
  return pcm.some((_, index) => index % 2 === 0 && Math.abs(pcm.readInt16LE(index)) >= 96);
}

function runEngine(command, args, wav, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (text) => {
      if (output.length < 32768) output += text;
    });
    child.stdin.on('error', () => {
      /* close reports the child's exit status */
    });
    child.once('error', () => {
      clearTimeout(timeout);
      reject(speechError(503, '서버에서 음성 인식 엔진을 시작할 수 없습니다.'));
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (timedOut) return reject(speechError(504, '발언 인식 시간이 초과되었습니다.'));
      if (code !== 0) return reject(speechError(503, '음성 인식 엔진이 발언을 처리하지 못했습니다.'));
      resolve(output);
    });
    child.stdin.end(wav);
  });
}

async function runWhisper(wav) {
  const text = await runEngine(executable, [
    '-m', modelPath, '-f', '-', '-l', 'ko', '-t', '4',
    '--vad', '--vad-model', vadModel, '--vad-min-speech-duration-ms', '120',
    '--vad-min-silence-duration-ms', '1800', '--vad-speech-pad-ms', '240',
    '-otxt', '-of', '-', '-np', '-sns', '-nf',
  ], wav);
  return text.replace(/\s+/gu, ' ').trim();
}

async function hasSpeech(wav) {
  const segments = await runEngine(vadExecutable, [
    '-vm', vadModel, '-f', '-', '-t', '1', '--vad-min-speech-duration-ms', '120', '-np',
  ], wav);
  const count = /^Detected (\d+) speech segments:/m.exec(segments);
  if (!count) throw speechError(503, '음성 감지 결과를 확인할 수 없습니다.');
  return Number(count[1]) > 0;
}

async function runQwen(wav) {
  if (!(await hasSpeech(wav))) return '';
  const text = await runEngine(qwenExecutable, [
    '--backend', 'qwen3', '-m', qwenFile, '-l', 'ko', '-t', '4', '-nt', '-np', '-f', '-',
  ], wav, 120000);
  return text.replace(/\s+/gu, ' ').trim();
}

async function runOpenAI(wav, key) {
  if (!(await hasSpeech(wav))) return '';

  const form = new FormData();
  form.set('model', cloudModel);
  form.set('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  form.append('languages[]', 'ko');
  const signal = AbortSignal.timeout(55000);
  let response;
  try {
    response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: form,
      signal, redirect: 'error',
    });
    if (response.ok) {
      const result = await response.json();
      if (typeof result?.text !== 'string' || result.text.length > 32768)
        throw speechError(502, 'OpenAI 전사 응답 형식을 확인할 수 없습니다.');
      return result.text.trim();
    }
    if (response.status === 429) {
      const reason = await response.json().catch(() => null);
      if (reason?.error?.code === 'insufficient_quota')
        throw speechError(424, 'OpenAI API 사용 한도 또는 결제 설정을 확인해 주세요.');
      throw speechError(429, 'OpenAI 전사 요청 한도에 도달했습니다. 잠시 뒤 다시 시도해 주세요.');
    }
    await response.body?.cancel();
    if ([401, 403, 404].includes(response.status))
      throw speechError(424, '서버의 OpenAI API 키와 전사 모델 접근 권한을 확인해 주세요.');
    if (response.status >= 400 && response.status < 500 && response.status !== 408)
      throw speechError(424, 'OpenAI가 음성 전사 요청을 거부했습니다.');
    throw speechError(502, 'OpenAI가 음성 전사를 완료하지 못했습니다.');
  } catch (error) {
    if (error.status) throw error;
    if (signal.aborted) throw speechError(504, 'OpenAI 전사 응답 시간이 초과되었습니다.');
    throw speechError(502, 'OpenAI 전사 응답을 받지 못했습니다.');
  }
}

async function recognize(wav, config) {
  if (!validateAudio(wav)) return '';
  if (!config.available) throw speechError(503, config.detail);
  if (outstanding >= queuedLimit)
    throw speechError(503, '전사 요청이 밀려 있습니다. 잠시 뒤 다시 시도해 주세요.');
  outstanding += 1;
  try {
    if (config.provider === 'openai') return await runOpenAI(wav, config.key);
    const engine = config.engine === 'qwen' ? runQwen : runWhisper;
    const task = queue.then(() => engine(wav));
    queue = task.catch(() => {});
    return await task;
  } finally {
    outstanding -= 1;
  }
}

export function prepareTranscription(expectedProvider) {
  // Bind this upload to the consented provider even if the key file changes mid-request.
  const config = providerConfig();
  if (expectedProvider !== config.provider && (expectedProvider !== undefined || config.provider === 'openai'))
    throw Object.assign(speechError(409, '전사 제공자가 변경되었습니다. 전사를 끄고 다시 켜서 음성 전송에 동의해 주세요.'), { code: 'stt_provider_changed' });
  if (!config.available) throw speechError(503, config.detail);
  return (wav) => recognize(wav, config);
}

// Offline quality evaluation always exercises the local model.
export function transcribeWav(wav) {
  return recognize(wav, localConfig());
}
