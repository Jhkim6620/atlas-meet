function encodeWav(frames, rate) {
  const input = new Float32Array(frames.reduce((sum, frame) => sum + frame.length, 0));
  let at = 0;
  for (const frame of frames) {
    input.set(frame, at);
    at += frame.length;
  }

  const ratio = rate / 16000;
  const count = Math.floor(input.length / ratio);
  const bytes = new ArrayBuffer(44 + count * 2);
  const view = new DataView(bytes);
  function label(offset, text) {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  }
  label(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  label(8, 'WAVE');
  label(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  label(36, 'data');
  view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    const sample = Math.max(-1, Math.min(1, sum / (end - start)));
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

export async function startSpeechCapture(stream, { onChunk, onError = () => {} }) {
  const track = stream.getAudioTracks().find((item) => item.readyState === 'live');
  if (!track) throw new Error('전사를 시작하려면 마이크를 연결해 주세요.');
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio || !window.AudioWorkletNode) {
    throw new Error('HTTPS 또는 localhost로 접속해 음성 전사를 이용해 주세요.');
  }
  const context = new Audio();
  let node;
  let source;
  let muted = !track.enabled;
  let epoch = 0;
  let utterance = [];
  let preRoll = [];
  let voicedSamples = 0;
  let quietSamples = 0;
  let total = 0;
  let startedAt = 0;
  let queue = Promise.resolve();
  let waiting = 0;
  let discard = false;
  let stopPromise;
  let acknowledge;
  const rate = context.sampleRate;

  function flush() {
    if (voicedSamples >= rate * 0.12 && !discard) {
      if (waiting >= 8) {
        onError(new Error('전사 대기가 길어 이번 발언을 저장하지 못했습니다.'));
      } else {
        const wav = encodeWav(utterance, rate);
        const id = crypto.randomUUID();
        const time = startedAt;
        waiting++;
        queue = queue
          .then(() => {
            if (!discard) return onChunk(wav, id, time);
          })
          .catch(onError)
          .finally(() => {
            waiting--;
          });
      }
    }
    utterance = [];
    preRoll = [];
    voicedSamples = quietSamples = total = 0;
  }

  function collect(frame) {
    let energy = 0;
    for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i];
    const voiced = Math.sqrt(energy / frame.length) >= 0.004;
    if (!utterance.length && !voiced) {
      preRoll.push(frame);
      if (preRoll.length > 6) preRoll.shift();
      return;
    }
    if (!utterance.length) {
      utterance = preRoll;
      preRoll = [];
      total = utterance.reduce((sum, sample) => sum + sample.length, 0);
      startedAt = Math.round(Date.now() - ((total + frame.length) * 1000) / rate);
    }
    utterance.push(frame);
    total += frame.length;
    if (voiced) {
      voicedSamples += frame.length;
      quietSamples = 0;
    } else {
      quietSamples += frame.length;
    }
    // Keep brief hesitations with their sentence. As the window fills, use a shorter
    // pause to cut between words before reaching Whisper's 30-second context limit.
    const pauseSeconds = total >= rate * 18 ? 0.4 : 2.0;
    if (quietSamples >= rate * pauseSeconds || total >= rate * 25) flush();
  }

  try {
    await context.audioWorklet.addModule(new URL('./speech-worklet.js', import.meta.url));
    source = context.createMediaStreamSource(new MediaStream([track]));
    node = new AudioWorkletNode(context, 'atlas-speech-frames', {
      channelCount: 1,
      channelCountMode: 'explicit',
      outputChannelCount: [1],
    });
    node.port.onmessage = ({ data }) => {
      if (data.done) acknowledge?.();
      else if (data.frame && !muted && !discard && data.epoch === epoch) collect(data.frame);
    };
    node.onprocessorerror = () =>
      onError(new Error('마이크 전사가 중단되었습니다. 마이크를 다시 켜 주세요.'));
    if (muted) node.port.postMessage({ type: 'mute', muted, epoch });
    source.connect(node);
    // The processor leaves its audio output at zero, preventing microphone feedback.
    node.connect(context.destination);
    await context.resume();
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }

  return {
    setMuted(value) {
      if (muted === value || stopPromise) return;
      muted = value;
      node.port.postMessage({ type: 'mute', muted, epoch: ++epoch });
      if (muted) flush();
    },
    stop({ flush: keep = true } = {}) {
      if (stopPromise) return stopPromise;
      discard = !keep;
      stopPromise = (async () => {
        // Drain frames already posted by the worklet before finalizing a short last turn.
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 200);
          acknowledge = () => {
            clearTimeout(timer);
            resolve();
          };
          node.port.postMessage({ type: 'finish' });
        });
        source.disconnect();
        node.disconnect();
        node.port.onmessage = null;
        node.port.close();
        flush();
        await context.close();
        await queue;
      })();
      return stopPromise;
    },
  };
}
