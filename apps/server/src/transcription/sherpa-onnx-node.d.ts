/** The native package currently ships JS/JSDoc without TypeScript declarations. */
declare module "sherpa-onnx-node" {
  export interface OfflineStream {
    acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
  }
  export class OfflineRecognizer {
    static createAsync(config: {
      featConfig: { sampleRate: number; featureDim: number };
      modelConfig: {
        transducer: { encoder: string; decoder: string; joiner: string };
        tokens: string;
        numThreads: number;
        provider: "cpu";
        modelType: "nemo_transducer";
      };
    }): Promise<OfflineRecognizer>;
    createStream(): OfflineStream;
    decodeAsync(stream: OfflineStream): Promise<{ text: string }>;
  }
  const sherpa: { OfflineRecognizer: typeof OfflineRecognizer };
  export default sherpa;
}
