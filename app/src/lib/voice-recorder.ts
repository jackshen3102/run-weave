export interface VoiceRecordingClip {
  mimeType: "audio/wav";
  audioBase64: string;
  sampleRateHz: 24_000;
  durationMs: number;
}

interface ActiveVoiceRecording {
  stop: () => Promise<VoiceRecordingClip>;
  cancel: () => Promise<void>;
}

const TARGET_SAMPLE_RATE = 24_000;

export async function startVoiceRecording(): Promise<ActiveVoiceRecording> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("当前环境不支持麦克风录音");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });
  const AudioContextCtor =
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioContextCtor) {
    stopStream(stream);
    throw new Error("当前环境不支持音频采集");
  }

  const audioContext = new AudioContextCtor();
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(input));
    const output = event.outputBuffer.getChannelData(0);
    output.fill(0);
  };
  source.connect(processor);
  processor.connect(audioContext.destination);

  const cleanup = async () => {
    processor.disconnect();
    source.disconnect();
    stopStream(stream);
    await audioContext.close().catch(() => undefined);
  };

  return {
    async stop() {
      await cleanup();
      const samples = flattenSamples(chunks);
      const resampled = resample(
        samples,
        audioContext.sampleRate,
        TARGET_SAMPLE_RATE,
      );
      const wavData = encodeWav(resampled, TARGET_SAMPLE_RATE);
      return {
        mimeType: "audio/wav",
        audioBase64: uint8ArrayToBase64(wavData),
        sampleRateHz: TARGET_SAMPLE_RATE,
        durationMs: Math.max(
          1,
          Math.round((resampled.length / TARGET_SAMPLE_RATE) * 1_000),
        ),
      };
    },
    async cancel() {
      await cleanup();
    },
  };
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function flattenSamples(chunks: Float32Array[]): Float32Array {
  const sampleCount = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const samples = new Float32Array(sampleCount);
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  return samples;
}

function resample(
  samples: Float32Array,
  sourceSampleRate: number,
  targetSampleRate: number,
): Float32Array {
  if (!samples.length || sourceSampleRate === targetSampleRate) {
    return samples;
  }
  const ratio = sourceSampleRate / targetSampleRate;
  const nextLength = Math.max(1, Math.round(samples.length / ratio));
  const resampled = new Float32Array(nextLength);
  for (let index = 0; index < nextLength; index += 1) {
    const sourceIndex = index * ratio;
    const before = Math.floor(sourceIndex);
    const after = Math.min(before + 1, samples.length - 1);
    const weight = sourceIndex - before;
    resampled[index] = samples[before] * (1 - weight) + samples[after] * weight;
  }
  return resampled;
}

function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytesPerSample = 2;
  const headerBytes = 44;
  const dataBytes = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(headerBytes + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = headerBytes;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(
      offset,
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
      true,
    );
    offset += bytesPerSample;
  }

  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
