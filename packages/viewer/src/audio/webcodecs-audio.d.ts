// WebCodecs audio, which TypeScript's DOM library (5.5) doesn't have yet: the parts the viewer uses.
declare class AudioData {
  readonly numberOfFrames: number
  readonly numberOfChannels: number
  copyTo(destination: Float32Array, options: { planeIndex: number; format?: string }): void
  close(): void
}

declare class EncodedAudioChunk {
  constructor(init: { type: 'key' | 'delta'; timestamp: number; data: BufferSource })
}

declare class AudioDecoder {
  constructor(init: { output: (data: AudioData) => void; error: (error: Error) => void })
  readonly state: 'unconfigured' | 'configured' | 'closed'
  configure(config: { codec: string; sampleRate: number; numberOfChannels: number }): void
  decode(chunk: EncodedAudioChunk): void
  close(): void
}
