// Listens in on the sound passing through it and hands it to the page in
// blocks of about a tenth of a second, as plain numbers, one channel. It
// changes nothing and keeps nothing. Captions are made from these blocks, on
// this device (captions.js).
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.max(128, Math.round(sampleRate / 10));
    this.block = new Float32Array(this.size);
    this.filled = 0;
    // Told to stop when captions stop, so that the browser can clear it away
    // (a tablet's home screen stays open through many visits).
    this.stopped = false;
    this.port.onmessage = (e) => { if (e.data === 'stop') this.stopped = true; };
  }

  process(inputs) {
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    const left = channels[0];
    const right = channels[1];
    for (let i = 0; i < left.length; i += 1) {
      this.block[this.filled] = right ? (left[i] + right[i]) / 2 : left[i];
      this.filled += 1;
      if (this.filled === this.size) {
        this.port.postMessage({ samples: this.block, rate: sampleRate }, [this.block.buffer]);
        this.block = new Float32Array(this.size);
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
