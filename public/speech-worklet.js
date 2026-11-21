// Send short mono frames to the page. Native-rate capture avoids mismatched
// MediaStream/AudioContext sample rates on devices using 44.1 or 48 kHz.
class SpeechFrames extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate * 0.04);
    this.frame = new Float32Array(this.size);
    this.offset = 0;
    this.epoch = 0;
    this.enabled = true;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'mute') {
        this.offset = 0;
        this.epoch = data.epoch;
        this.enabled = !data.muted;
      }
      if (data.type === 'finish') {
        if (this.enabled && this.offset) this.send(this.frame.slice(0, this.offset));
        this.enabled = false;
        this.port.postMessage({ done: true });
      }
    };
  }

  send(frame) {
    this.port.postMessage({ frame, epoch: this.epoch }, [frame.buffer]);
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!this.enabled || !input) return true;
    let at = 0;
    while (at < input.length) {
      const count = Math.min(this.size - this.offset, input.length - at);
      this.frame.set(input.subarray(at, at + count), this.offset);
      at += count;
      this.offset += count;
      if (this.offset === this.size) {
        this.send(this.frame);
        this.frame = new Float32Array(this.size);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('atlas-speech-frames', SpeechFrames);
