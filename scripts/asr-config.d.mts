export interface AsrConfig {
  readonly model: 'large-v3-turbo' | 'large-v3' | 'qwen3-asr-1.7b';
  readonly language: 'en';
  readonly initialPrompt: string;
  readonly beamSize?: number;
  /** Qwen-only cumulative live previews; enabled in its trial configuration. */
  readonly livePreview?: boolean;
  readonly previewIntervalMs?: number;
  readonly port: number;
  readonly inferencePort: number;
  readonly endpointSilenceMs: number;
  readonly maxUtteranceSeconds: number;
  readonly rmsThreshold: number;
  readonly preRollMs: number;
}
export function asrConfigPath(root?: string, override?: string): string;
export function validateAsrConfig(value: unknown): AsrConfig;
export function readAsrConfig(root?: string, override?: string): Promise<AsrConfig>;
