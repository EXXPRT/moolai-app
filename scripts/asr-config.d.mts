export interface AsrConfig {
  readonly model: 'large-v3-turbo' | 'large-v3';
  readonly language: 'en';
  readonly initialPrompt: string;
  readonly port: number;
  readonly inferencePort: number;
  readonly endpointSilenceMs: number;
  readonly maxUtteranceSeconds: number;
  readonly rmsThreshold: number;
  readonly preRollMs: number;
}
export function asrConfigPath(root?: string): string;
export function validateAsrConfig(value: unknown): AsrConfig;
export function readAsrConfig(root?: string): Promise<AsrConfig>;
