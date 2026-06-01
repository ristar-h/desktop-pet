/**
 * Desktop Pet - Action Types
 *
 * Directory structure:
 * $APPDATA/avatars/{avatar_id}/
 * ├── manifest.json
 * ├── idle/
 * │   ├── 01.png ~ 08.png
 * ├── walk/
 * │   ├── 01.png ~ 08.png
 * └── ...
 */

/** All supported action states (standalone version - no "work" state) */
export type ActionState =
  | "idle"
  | "walk"
  | "sleep"
  | "happy"
  | "sad"
  | "stretch"
  | "looking_around"
  | "drag";

/** Single action config */
export interface ActionConfig {
  fps: number;
  loop: boolean;
  frames: string[];
}

/** manifest.json structure */
export interface AvatarManifest {
  id: string;
  name: string;
  canvasWidth: number;
  canvasHeight: number;
  anchor: { x: number; y: number };
  actions: Partial<Record<ActionState, ActionConfig>>;
  /** Unix timestamp (ms) when this avatar was created */
  createdAt?: number;
}

/** Runtime loaded avatar pack */
export interface AvatarPack {
  manifest: AvatarManifest;
  rootPath: string;
  frameCache: Partial<Record<ActionState, string[]>>;
}

/** Default action specs */
export const DEFAULT_ACTION_SPECS: Record<
  ActionState,
  { fps: number; loop: boolean; defaultFrames: number }
> = {
  idle: { fps: 3, loop: true, defaultFrames: 8 },
  walk: { fps: 4, loop: true, defaultFrames: 8 },
  sleep: { fps: 1, loop: true, defaultFrames: 6 },
  happy: { fps: 5, loop: false, defaultFrames: 8 },
  sad: { fps: 3, loop: false, defaultFrames: 6 },
  stretch: { fps: 4, loop: false, defaultFrames: 8 },
  looking_around: { fps: 3, loop: false, defaultFrames: 8 },
  drag: { fps: 3, loop: true, defaultFrames: 6 },
};

/** All actions in generation order */
export const ALL_ACTIONS: ActionState[] = [
  "idle",
  "walk",
  "happy",
  "sleep",
  "sad",
  "stretch",
  "looking_around",
  "drag",
];
