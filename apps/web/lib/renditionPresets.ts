export interface Rendition {
  name: string;
  width: number;
  height: number;
  videoBitrateKbps: number;
  audioBitrateKbps: number;
}

export interface RenditionPreset {
  id: string;
  label: string;
  renditions: Rendition[];
}

// Named presets shown in the rendition picker. SubmitTranscodeJob accepts an
// arbitrary profile — these are just the dashboard's curated shortcuts.
export const RENDITION_PRESETS: RenditionPreset[] = [
  {
    id: "720p-360p",
    label: "720p + 360p",
    renditions: [
      { name: "720p", width: 1280, height: 720, videoBitrateKbps: 2500, audioBitrateKbps: 128 },
      { name: "360p", width: 640, height: 360, videoBitrateKbps: 800, audioBitrateKbps: 96 },
    ],
  },
  {
    id: "1080p-720p-360p",
    label: "1080p + 720p + 360p",
    renditions: [
      { name: "1080p", width: 1920, height: 1080, videoBitrateKbps: 5000, audioBitrateKbps: 160 },
      { name: "720p", width: 1280, height: 720, videoBitrateKbps: 2500, audioBitrateKbps: 128 },
      { name: "360p", width: 640, height: 360, videoBitrateKbps: 800, audioBitrateKbps: 96 },
    ],
  },
  {
    id: "480p-only",
    label: "480p only",
    renditions: [
      { name: "480p", width: 854, height: 480, videoBitrateKbps: 1200, audioBitrateKbps: 96 },
    ],
  },
];

export const DEFAULT_RENDITION_PRESET_ID = RENDITION_PRESETS[0].id;

// Falls back to the default preset if the id is unknown (e.g. a stale
// selection), so callers always get a usable rendition list.
export function getRenditionPreset(id: string): RenditionPreset {
  return RENDITION_PRESETS.find((p) => p.id === id) ?? RENDITION_PRESETS[0];
}
