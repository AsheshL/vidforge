import { describe, expect, it } from "vitest";
import { DEFAULT_RENDITION_PRESET_ID, RENDITION_PRESETS, getRenditionPreset } from "./renditionPresets";

describe("renditionPresets", () => {
  it("has unique, non-empty preset ids", () => {
    const ids = RENDITION_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
  });

  it("every preset has at least one rendition", () => {
    for (const preset of RENDITION_PRESETS) {
      expect(preset.renditions.length).toBeGreaterThan(0);
    }
  });

  it("resolves a known preset id", () => {
    expect(getRenditionPreset("480p-only")).toEqual(
      expect.objectContaining({ id: "480p-only" }),
    );
  });

  it("falls back to the default preset for an unknown id", () => {
    expect(getRenditionPreset("does-not-exist").id).toBe(DEFAULT_RENDITION_PRESET_ID);
  });
});
