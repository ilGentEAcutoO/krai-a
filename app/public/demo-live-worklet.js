// AudioWorklet for the live demo mic (loaded by demo-live.js). A same-origin
// file so a strict `script-src 'self'` CSP allows it (no blob: modules).
// Posts a copy of each 128-sample render block; the main thread downsamples.
class KraiMicTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('krai-mic-tap', KraiMicTap);
