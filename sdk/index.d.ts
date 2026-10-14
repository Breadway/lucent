export type Compatibility = "browser-only" | "portable" | "native-only";
export interface Node {
  type: string;
  children?: Node[];
  [key: string]: unknown;
}
export interface Dependency {
  path: string;
  producerVersion?: string;
}
export interface Scene {
  id: string;
  duration: number;
  start?: number;
  renderer?: Compatibility;
  requires?: string[];
  dependencies?: Array<string | Dependency>;
  frame: (
    time: number,
    context: { time: number; scene: Scene; random: () => number },
  ) => Node | Node[];
}
export interface Film {
  apiVersion?: string;
  duration: number;
  scenes: Scene[];
  seed?: number;
  background?: string;
}

export interface TtsProvider {
  apiVersion: "0.1.0";
  capabilities?: string[];
  generate(request: {
    project: unknown;
    config: unknown;
    script: { schemaVersion: 1; film: string; cues: unknown[] };
    out: string;
    maxRequests: number;
    signal: AbortSignal;
  }): Promise<{ schemaVersion: 1; cues: unknown[] }>;
}

export interface AudioProvider {
  apiVersion: "0.1.0";
  capabilities?: string[];
  render(request: {
    project: unknown;
    timeline: unknown;
    out: string;
    signal: AbortSignal;
  }): Promise<string>;
}

export function defineFilm(film: Omit<Film, "duration">): Film;
export function frameGraph(film: Film, time: number): Node;
export function group(children: Node[], props?: Record<string, unknown>): Node;
export function rect(
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
  props?: Record<string, unknown>,
): Node;
export function circle(
  x: number,
  y: number,
  radius: number,
  color: string,
  props?: Record<string, unknown>,
): Node;
export interface TextProps {
  font?: string;
  size?: number;
  color?: string;
  weight?: number;
  style?: string;
  lineHeight?: number;
  align?: "left" | "center" | "right";
  wrapWidth?: number;
  kerning?: boolean;
  ligatures?: boolean;
  /** Extra advance after every character, in design px. Default 0. */
  letterSpacing?: number;
  [key: string]: unknown;
}
export function text(
  value: string,
  x: number,
  y: number,
  props?: TextProps,
): Node;
export function image(
  src: string,
  x: number,
  y: number,
  width: number,
  height: number,
  props?: Record<string, unknown>,
): Node;
export function path(
  commands: Array<Array<string | number>>,
  props?: Record<string, unknown>,
): Node;
export function video(
  src: string,
  x: number,
  y: number,
  width: number,
  height: number,
  props?: Record<string, unknown>,
): Node;
export function svg(
  markup: string,
  props?: {
    grain?: { seed: number; opacity?: number; width?: number; height?: number };
    [key: string]: unknown;
  },
): Node;
export const camera: typeof group;
export function clamp(x: number, a?: number, b?: number): number;
export function lerp(a: number, b: number, t: number): number;
export const ease: Record<string, (time: number) => number>;
export function rng(seed: number): () => number;
export function sourceTime(
  t: number,
  options: { trim?: number; rate?: number; duration?: number; loop?: boolean },
): number;
export function applyNarration(film: Film, timing?: unknown): Film;
export const API_VERSION: string;
export function extensionRegistry(): {
  register(
    kind: string,
    name: string,
    provider: {
      apiVersion: string;
      capabilities?: string[];
      [key: string]: unknown;
    },
  ): void;
  get(kind: string, name: string): unknown;
  capabilities(): Array<{
    id: string;
    apiVersion: string;
    capabilities: string[];
  }>;
};
