"use client";

import { useState } from "react";
import { DEFAULT_RENDITION_PRESET_ID, RENDITION_PRESETS } from "@/lib/renditionPresets";

// Inline preset picker shown in place of a row's action buttons while the
// user decides on a rendition profile, for both new transcodes and re-runs.
export function RenditionPicker({
  submitLabel = "Start",
  onSubmit,
  onCancel,
}: {
  submitLabel?: string;
  onSubmit: (presetId: string) => void;
  onCancel: () => void;
}) {
  const [presetId, setPresetId] = useState(DEFAULT_RENDITION_PRESET_ID);

  return (
    <div className="flex items-center justify-end gap-1.5">
      <select
        value={presetId}
        onChange={(e) => setPresetId(e.target.value)}
        className="rounded border border-slate-700 bg-slate-900 px-1.5 py-1 text-xs text-slate-200"
      >
        {RENDITION_PRESETS.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.label}
          </option>
        ))}
      </select>
      <button
        onClick={() => onSubmit(presetId)}
        className="rounded bg-emerald-700 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-600"
      >
        {submitLabel}
      </button>
      <button
        onClick={onCancel}
        className="rounded bg-slate-800 px-2 py-1 text-xs font-medium text-slate-400 hover:bg-slate-700"
      >
        Cancel
      </button>
    </div>
  );
}
