class Live2DRealtimePcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameSamples = Math.max(1, Math.round(sampleRate * 0.02));
    this.frame = new Float32Array(this.frameSamples);
    this.offset = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    if (input) {
      let inputOffset = 0;
      while (inputOffset < input.length) {
        const count = Math.min(input.length - inputOffset, this.frame.length - this.offset);
        this.frame.set(input.subarray(inputOffset, inputOffset + count), this.offset);
        this.offset += count;
        inputOffset += count;
        if (this.offset === this.frame.length) {
          const samples = this.frame;
          this.port.postMessage({ type: "samples", sampleRate, samples: samples.buffer }, [samples.buffer]);
          this.frame = new Float32Array(this.frameSamples);
          this.offset = 0;
        }
      }
    }

    for (const output of outputs[0] ?? []) output.fill(0);
    return true;
  }
}

registerProcessor("live2d-realtime-pcm-capture", Live2DRealtimePcmCaptureProcessor);
