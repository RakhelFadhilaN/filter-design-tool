"use client";

import { useState, useCallback, useRef, useEffect } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type BandType = "lowpass" | "highpass" | "bandpass" | "bandstop";
type FilterStructure = "IIR" | "FIR";
type FilterType = "butter" | "cheby1" | "ellip" | "bessel";
type Mode = "cascade" | "parallel";
type OutputFormat = "sos" | "ab";

interface FilterStage {
  id: number;
  filter_type: FilterType;
  filter_structure: FilterStructure;
  band_type: BandType;
  order: number;
  cutoff?: number;
  cutoff_low?: number;
  cutoff_high?: number;
  bp_fc: number;
  bp_bandwidth_oct: number;
  bp_gain_db: number;
  gain_db: number;
}

interface Preset {
  id: number;
  name: string;
  description?: string;
  config: ChainConfig;
  created_at: string;
}

interface ChainConfig {
  filter_structure: FilterStructure;
  filter_type: FilterType;
  order: number;
  mode: Mode;
  output_format: OutputFormat;
  fs: number;
  bands: BandConfig[];
}

interface BandConfig {
  band_type: BandType;
  gain_db: number;
  cutoff?: number;
  cutoff_low?: number;
  cutoff_high?: number;
  fc?: number;
  bandwidth_oct?: number;
}

interface SimResult {
  preset_id: number;
  name: string;
  freqs: number[];
  combined: { db: number[] };
  bands: { label: string; db: number[] }[];
  mode: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let globalId = 0;
const uid = () => ++globalId;

function defaultStage(): FilterStage {
  return {
    id: uid(),
    filter_type: "butter",
    filter_structure: "IIR",
    band_type: "lowpass",
    order: 4,
    cutoff: 1000,
    cutoff_low: 800,
    cutoff_high: 1200,
    bp_fc: 1000,
    bp_bandwidth_oct: 0.333,
    bp_gain_db: 0,
    gain_db: 0,
  };
}

function bandToApiShape(s: FilterStage): BandConfig {
  if (s.band_type === "lowpass" || s.band_type === "highpass") {
    return { band_type: s.band_type, gain_db: s.gain_db, cutoff: s.cutoff };
  }
  if (s.band_type === "bandstop") {
    return { band_type: s.band_type, gain_db: s.gain_db, cutoff_low: s.cutoff_low, cutoff_high: s.cutoff_high };
  }
  return { band_type: s.band_type, gain_db: s.bp_gain_db, fc: s.bp_fc, bandwidth_oct: s.bp_bandwidth_oct };
}

/** Convert a saved preset config back into UI stages */
function configToStages(config: ChainConfig): FilterStage[] {
  return config.bands.map((b) => {
    const s = defaultStage();
    s.filter_type = config.filter_type;
    s.filter_structure = config.filter_structure;
    s.order = config.order;
    s.band_type = b.band_type;
    s.gain_db = b.gain_db ?? 0;
    if (b.cutoff !== undefined) s.cutoff = b.cutoff;
    if (b.cutoff_low !== undefined) s.cutoff_low = b.cutoff_low;
    if (b.cutoff_high !== undefined) s.cutoff_high = b.cutoff_high;
    if (b.fc !== undefined) s.bp_fc = b.fc;
    if (b.bandwidth_oct !== undefined) s.bp_bandwidth_oct = b.bandwidth_oct;
    if (b.gain_db !== undefined) s.bp_gain_db = b.gain_db;
    return s;
  });
}

const COMPARE_COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948"];

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export default function FilterDesigner() {
  const [mode, setMode] = useState<Mode>("cascade");
  const [outputFormat, setOutputFormat] = useState<OutputFormat>("sos");
  const [stages, setStages] = useState<FilterStage[]>([defaultStage()]);
  const [numBands, setNumBands] = useState(1);
  const [plotUrl, setPlotUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Presets (DB-backed)
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(false);

  // Save modal
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveDesc, setSaveDesc] = useState("");
  const [saving, setSaving] = useState(false);

  // Compare
  const [compareMode, setCompareMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [compareResults, setCompareResults] = useState<SimResult[]>([]);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);

  // Resizable sidebar
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const isResizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onMouseDown = (e: React.MouseEvent) => {
    isResizing.current = true;
    startX.current = e.clientX;
    startWidth.current = sidebarWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      setSidebarWidth(Math.min(560, Math.max(240, startWidth.current + e.clientX - startX.current)));
    };
    const onMouseUp = () => {
      if (!isResizing.current) return;
      isResizing.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // Load presets on mount
  useEffect(() => {
    fetchPresets();
  }, []);

  // Auto-compare when 2+ presets are selected
  useEffect(() => {
    if (selectedIds.length >= 2) {
      runCompare();
    } else {
      setCompareResults([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds]);

  // ── Band management ────────────────────────────────────────────────────────

  const handleNumBandsChange = (n: number) => {
    const clamped = Math.max(1, Math.min(16, n));
    setNumBands(clamped);
    setStages((prev) => {
      if (clamped > prev.length) {
        const toAdd = Array.from({ length: clamped - prev.length }, defaultStage);
        const first = prev[0];
        return [
          ...prev,
          ...toAdd.map((s) => ({
            ...s,
            filter_type: first?.filter_type ?? s.filter_type,
            filter_structure: first?.filter_structure ?? s.filter_structure,
            order: first?.order ?? s.order,
          })),
        ];
      }
      return prev.slice(0, clamped);
    });
  };

  const updateStage = (id: number, patch: Partial<FilterStage>) =>
    setStages((p) => p.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const buildBody = (): ChainConfig => {
    const first = stages[0];
    return {
      filter_structure: first?.filter_structure ?? "IIR",
      filter_type: first?.filter_type ?? "butter",
      order: first?.order ?? 4,
      mode,
      output_format: outputFormat,
      fs: 44100,
      bands: stages.map(bandToApiShape),
    };
  };

  // ── API calls ──────────────────────────────────────────────────────────────

  const runFilter = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPlotUrl(null);
    try {
      const res = await fetch("${API}/filter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      setPlotUrl(URL.createObjectURL(blob));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, outputFormat, stages]);

  const downloadJson = useCallback(async () => {
    try {
      const res = await fetch("${API}/filter/coeffs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      const data = await res.json();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
      );
      a.download = "filter_coeffs.json";
      a.click();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, outputFormat, stages]);

  const fetchPresets = async () => {
    setPresetsLoading(true);
    try {
      const res = await fetch("${API}/presets");
      if (!res.ok) throw new Error(await res.text());
      const data: Preset[] = await res.json();
      setPresets(data);
    } catch {
      // silently fail — presets panel will just be empty
    } finally {
      setPresetsLoading(false);
    }
  };

  const savePreset = async () => {
    if (!saveName.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("${API}/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: saveName.trim(),
          description: saveDesc.trim() || null,
          config: buildBody(),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setSaveModalOpen(false);
      setSaveName("");
      setSaveDesc("");
      await fetchPresets();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const deletePreset = async (id: number) => {
    try {
      await fetch(`${API}/presets/${id}`, { method: "DELETE" });
      setSelectedIds((prev) => prev.filter((x) => x !== id));
      setPresets((prev) => prev.filter((p) => p.id !== id));
    } catch {
      // silently fail
    }
  };

  const loadPreset = (preset: Preset) => {
    const newStages = configToStages(preset.config);
    setStages(newStages);
    setNumBands(newStages.length);
    setMode(preset.config.mode);
    setOutputFormat(preset.config.output_format);
    setPlotUrl(null);
    setCompareMode(false);
  };

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const runCompare = async () => {
    if (selectedIds.length < 2) return;
    setCompareLoading(true);
    setCompareError(null);
    try {
      const res = await fetch("${API}/presets/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selectedIds),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setCompareResults(data.presets);
    } catch (e: unknown) {
      setCompareError(e instanceof Error ? e.message : String(e));
    } finally {
      setCompareLoading(false);
    }
  };

  // ── Global filter controls ─────────────────────────────────────────────────

  const globalFilterType      = stages[0]?.filter_type      ?? "butter";
  const globalFilterStructure = stages[0]?.filter_structure ?? "IIR";
  const globalOrder           = stages[0]?.order            ?? 4;

  const setGlobalFilterType      = (v: FilterType)      => setStages((p) => p.map((s) => ({ ...s, filter_type: v })));
  const setGlobalFilterStructure = (v: FilterStructure) => setStages((p) => p.map((s) => ({ ...s, filter_structure: v })));
  const setGlobalOrder           = (v: number)          => setStages((p) => p.map((s) => ({ ...s, order: v })));

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen p-6 bg-white font-mono">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-base font-medium text-black tracking-tight">Filter Designer</h1>
        <button
          onClick={() => setCompareMode((v) => !v)}
          className={`text-xs px-3 py-1.5 border font-medium transition-colors ${
            compareMode
              ? "bg-black text-white border-black"
              : "bg-white text-black border-black hover:bg-gray-100"
          }`}
        >
          {compareMode ? "← Back to Editor" : "Compare presets"}
        </button>
      </div>

      {compareMode ? (
        /* ── COMPARE VIEW ──────────────────────────────────────────────────── */
        <CompareView
          presets={presets}
          selectedIds={selectedIds}
          onToggle={toggleSelect}
          onDelete={deletePreset}
          onLoad={(p) => { loadPreset(p); }}
          compareResults={compareResults}
          compareLoading={compareLoading}
          compareError={compareError}
          presetsLoading={presetsLoading}
          onRefresh={fetchPresets}
        />
      ) : (
        /* ── EDITOR VIEW ───────────────────────────────────────────────────── */
        <div className="flex gap-0 items-start">
          {/* SIDEBAR */}
          <div style={{ width: sidebarWidth }} className="relative z-10 shrink-0 space-y-3 pr-3">

            <Section label="Chain mode">
              <SegmentedControl
                options={[{ label: "Cascade", value: "cascade" }, { label: "Parallel", value: "parallel" }]}
                value={mode}
                onChange={(v) => setMode(v as Mode)}
              />
              <p className="text-[10px] text-gray-400 mt-1 leading-snug">
                {mode === "cascade" ? "Responses multiply" : "Responses averaged"}
              </p>
            </Section>

            <Section label="Filters">
              <div className="space-y-3">
                <div>
                  <SegmentedControl
                    options={[{ label: "IIR", value: "IIR" }, { label: "FIR", value: "FIR" }]}
                    value={globalFilterStructure}
                    onChange={(v) => setGlobalFilterStructure(v as FilterStructure)}
                  />
                  <p className="text-[10px] text-gray-400 mt-1 leading-snug">
                    {globalFilterStructure === "IIR" ? "Infinite impulse response" : "Finite impulse response"}
                  </p>
                </div>

                {globalFilterStructure === "IIR" && (
                  <SelectRow label="Filter Type" value={globalFilterType} onChange={(v) => setGlobalFilterType(v as FilterType)}>
                    <option value="butter">Butterworth</option>
                    <option value="cheby1">Chebyshev I</option>
                    <option value="ellip">Elliptic</option>
                    <option value="bessel">Bessel</option>
                  </SelectRow>
                )}

                <SliderRow label="Filter order" min={1} max={12} step={1} value={globalOrder} onChange={setGlobalOrder} display={String(globalOrder)} />

                <div>
                  <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">Titik band</p>
                  <div className="flex items-center gap-2">
                    <button onClick={() => handleNumBandsChange(numBands - 1)} disabled={numBands <= 1} className="w-7 h-7 border border-black text-black text-sm flex items-center justify-center hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors select-none">−</button>
                    <input
                      type="number" min={1} max={16} value={numBands}
                      onChange={(e) => { const v = parseInt(e.target.value); if (!isNaN(v)) handleNumBandsChange(v); }}
                      className="flex-1 text-center border border-gray-300 text-xs py-1.5 text-black outline-none focus:border-black [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                    <button onClick={() => handleNumBandsChange(numBands + 1)} disabled={numBands >= 16} className="w-7 h-7 border border-black text-black text-sm flex items-center justify-center hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors select-none">+</button>
                  </div>
                  <p className="text-[10px] text-gray-400 mt-1 leading-snug">{numBands === 1 ? "1 band" : `${numBands} bands`}</p>
                </div>
              </div>
            </Section>

            {stages.map((stage, idx) => (
              <BandCard key={stage.id} stage={stage} index={idx} onUpdate={(patch) => updateStage(stage.id, patch)} />
            ))}

            <Section label="Output format">
              <SegmentedControl
                options={[{ label: "SOS", value: "sos" }, { label: "A/B", value: "ab" }]}
                value={outputFormat}
                onChange={(v) => setOutputFormat(v as OutputFormat)}
              />
              <p className="text-[10px] text-gray-400 mt-1 leading-snug">
                {outputFormat === "sos" ? "Second-order sections" : "Direct b/a polynomials"}
              </p>
            </Section>

            <div className="space-y-2 pt-1">
              <button onClick={runFilter} disabled={loading || stages.length === 0} className="w-full py-2.5 bg-black text-white text-sm font-medium hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                {loading ? "simulating…" : "Simulate"}
              </button>
              <button onClick={downloadJson} disabled={loading || stages.length === 0} className="w-full py-2.5 border border-black text-black text-sm font-medium hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                Download JSON
              </button>
            </div>
          </div>

          {/* RESIZE HANDLE */}
          <div onMouseDown={onMouseDown} className="relative z-0 w-3 self-stretch flex items-center justify-center cursor-col-resize group shrink-0">
            <div className="w-px h-full bg-gray-200 group-hover:bg-gray-500 transition-colors" />
          </div>

          {/* PLOT AREA */}
          <div className="flex-1 flex flex-col min-h-[360px] ml-1">
            <div className="border border-gray-200 flex-1 flex items-center justify-center bg-gray-50 overflow-hidden" style={{ minHeight: 360 }}>
              {!plotUrl && !loading && !error && <p className="text-xs text-gray-400">plot will appear here</p>}
              {loading && <p className="text-xs text-gray-400 animate-pulse">generating…</p>}
              {error && <p className="text-xs text-red-500 px-4 text-center">{error}</p>}
              {plotUrl && !loading && <img src={plotUrl} alt="frequency response" className="w-full h-full object-contain block" />}
            </div>

            {/* Save to DB */}
            {plotUrl && !loading && (
              <div className="mt-2 flex items-center gap-3">
                <button
                  onClick={() => setSaveModalOpen(true)}
                  className="px-4 py-2 border border-black text-black text-xs font-medium hover:bg-gray-100 transition-colors"
                >
                  Save preset
                </button>
                <span className="text-[10px] text-gray-400">
                  {presets.length === 0 ? "No saved presets" : `${presets.length} preset${presets.length > 1 ? "s" : ""} saved`}
                </span>
              </div>
            )}

            {/* Saved presets strip */}
            {presets.length > 0 && (
              <div className="mt-3 border-t border-gray-200 pt-3">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wide">Saved presets</p>
                  <button onClick={fetchPresets} className="text-[10px] text-gray-400 hover:text-black transition-colors">↻ refresh</button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {presets.map((p) => (
                    <PresetChip
                      key={p.id}
                      preset={p}
                      onLoad={() => loadPreset(p)}
                      onDelete={() => deletePreset(p.id)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Save Modal */}
      {saveModalOpen && (
        <SaveModal
          name={saveName}
          desc={saveDesc}
          saving={saving}
          onName={setSaveName}
          onDesc={setSaveDesc}
          onSave={savePreset}
          onClose={() => { setSaveModalOpen(false); setSaveName(""); setSaveDesc(""); }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Save Modal
// ─────────────────────────────────────────────────────────────────────────────

function SaveModal({ name, desc, saving, onName, onDesc, onSave, onClose }: {
  name: string; desc: string; saving: boolean;
  onName: (v: string) => void; onDesc: (v: string) => void;
  onSave: () => void; onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white border border-black w-80 font-mono">
        <div className="px-4 py-3 border-b border-black bg-black text-white flex items-center justify-between">
          <span className="text-xs font-medium tracking-wide">Save preset</span>
          <button onClick={onClose} className="text-white hover:text-gray-300 text-sm leading-none">×</button>
        </div>
        <div className="p-4 space-y-3">
          <div className="space-y-1">
            <p className="text-[10px] text-gray-500 uppercase tracking-wide">Name *</p>
            <input
              type="text"
              value={name}
              onChange={(e) => onName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && name.trim() && onSave()}
              placeholder="e.g. Low-shelf boost"
              autoFocus
              className="w-full border border-gray-300 text-xs px-2 py-1.5 text-black outline-none focus:border-black"
            />
          </div>
          <div className="space-y-1">
            <p className="text-[10px] text-gray-500 uppercase tracking-wide">Description (optional)</p>
            <input
              type="text"
              value={desc}
              onChange={(e) => onDesc(e.target.value)}
              placeholder="Short note…"
              className="w-full border border-gray-300 text-xs px-2 py-1.5 text-black outline-none focus:border-black"
            />
          </div>
          <div className="flex gap-2 pt-1">
            <button
              onClick={onSave}
              disabled={!name.trim() || saving}
              className="flex-1 py-2 bg-black text-white text-xs font-medium hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? "saving…" : "Save"}
            </button>
            <button onClick={onClose} className="flex-1 py-2 border border-black text-black text-xs font-medium hover:bg-gray-100 transition-colors">
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Preset Chip (in editor strip)
// ─────────────────────────────────────────────────────────────────────────────

function PresetChip({ preset, onLoad, onDelete }: { preset: Preset; onLoad: () => void; onDelete: () => void }) {
  const dt = new Date(preset.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="border border-gray-200 bg-white flex items-center gap-0 text-xs group">
      <button
        onClick={onLoad}
        title={`Load "${preset.name}" into editor`}
        className="px-2 py-1 text-black hover:bg-gray-100 transition-colors text-left"
      >
        <span className="font-medium">{preset.name}</span>
        <span className="text-gray-400 ml-1.5 tabular-nums text-[10px]">{dt}</span>
      </button>
      <button
        onClick={onDelete}
        className="px-1.5 py-1 text-gray-300 hover:text-red-500 transition-colors border-l border-gray-200 text-sm leading-none"
        title="Delete"
      >×</button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Compare View
// ─────────────────────────────────────────────────────────────────────────────

interface CompareViewProps {
  presets: Preset[];
  selectedIds: number[];
  onToggle: (id: number) => void;
  onDelete: (id: number) => void;
  onLoad: (p: Preset) => void;
  compareResults: SimResult[];
  compareLoading: boolean;
  compareError: string | null;
  presetsLoading: boolean;
  onRefresh: () => void;
}

function CompareView({
  presets, selectedIds, onToggle, onDelete, onLoad,
  compareResults, compareLoading, compareError, presetsLoading, onRefresh,
}: CompareViewProps) {
  if (!presetsLoading && presets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] text-center gap-3">
        <p className="text-sm text-gray-500">No saved presets yet.</p>
        <p className="text-xs text-gray-400 max-w-xs leading-relaxed">
          Go back to the editor, simulate a filter, then click <strong>Save preset</strong> to store its settings in the database.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Preset list */}
      <div className="border border-black">
        <div className="px-3 py-2 border-b border-black bg-black text-white flex items-center justify-between">
          <span className="text-xs font-medium tracking-wide">Saved presets — select 2 or more to compare</span>
          <button onClick={onRefresh} className="text-gray-300 hover:text-white text-[10px] transition-colors">↻ refresh</button>
        </div>
        <div className="divide-y divide-gray-100">
          {presetsLoading && (
            <p className="text-xs text-gray-400 px-3 py-3 animate-pulse">Loading…</p>
          )}
          {presets.map((p, i) => {
            const selected = selectedIds.includes(p.id);
            const colorIdx = selectedIds.indexOf(p.id);
            const color = colorIdx >= 0 ? COMPARE_COLORS[colorIdx % COMPARE_COLORS.length] : null;
            return (
              <div
                key={p.id}
                className={`flex items-center justify-between px-3 py-2 cursor-pointer transition-colors ${selected ? "bg-gray-50" : "hover:bg-gray-50"}`}
                onClick={() => onToggle(p.id)}
              >
                <div className="flex items-center gap-3 min-w-0">
                  {/* Color swatch / checkbox */}
                  <div
                    className="w-3 h-3 border shrink-0 transition-colors"
                    style={{
                      backgroundColor: color ?? "transparent",
                      borderColor: color ?? "#d1d5db",
                    }}
                  />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-black truncate">{p.name}</p>
                    {p.description && <p className="text-[10px] text-gray-400 truncate">{p.description}</p>}
                  </div>
                  <span className="text-[10px] text-gray-400 tabular-nums shrink-0">
                    {new Date(p.created_at).toLocaleDateString([], { month: "short", day: "numeric" })}
                  </span>
                </div>
                <div className="flex items-center gap-2 ml-3 shrink-0">
                  <button
                    onClick={(e) => { e.stopPropagation(); onLoad(p); }}
                    className="text-[10px] px-2 py-1 border border-gray-300 text-gray-600 hover:border-black hover:text-black transition-colors"
                    title="Load into editor"
                  >
                    Load
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onDelete(p.id); }}
                    className="text-gray-300 hover:text-red-500 transition-colors text-sm leading-none"
                    title="Delete"
                  >×</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Status / results */}
      {selectedIds.length < 2 && (
        <p className="text-xs text-gray-400 text-center">
          {selectedIds.length === 0 ? "Select at least 2 presets above to compare." : "Select one more preset to start comparing."}
        </p>
      )}

      {compareLoading && (
        <p className="text-xs text-gray-400 text-center animate-pulse">Running simulations…</p>
      )}

      {compareError && (
        <p className="text-xs text-red-500 text-center">{compareError}</p>
      )}

      {compareResults.length >= 2 && !compareLoading && (
        <CompareCharts results={compareResults} />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Compare Charts — canvas-based overlay + side-by-side
// ─────────────────────────────────────────────────────────────────────────────

function CompareCharts({ results }: { results: SimResult[] }) {
  return (
    <div className="space-y-4">
      {/* Overlay chart */}
      <div className="border border-black">
        <div className="px-3 py-2 border-b border-black bg-black text-white">
          <span className="text-xs font-medium tracking-wide">Overlay — combined response</span>
        </div>
        <div className="p-3 bg-gray-50">
          <FreqResponseCanvas
            traces={results.map((r, i) => ({
              label: r.name,
              freqs: r.freqs,
              db: r.combined.db,
              color: COMPARE_COLORS[i % COMPARE_COLORS.length],
              width: 2,
            }))}
            height={400}
          />
        </div>
      </div>

      {/* Side-by-side individual */}
      <div className={`grid gap-4 ${results.length === 2 ? "grid-cols-2" : "grid-cols-2"}`}>
        {results.map((r, i) => (
          <div key={r.preset_id} className="border border-gray-300">
            <div
              className="px-3 py-2 border-b flex items-center gap-2"
              style={{ borderColor: COMPARE_COLORS[i % COMPARE_COLORS.length] + "66" }}
            >
              <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: COMPARE_COLORS[i % COMPARE_COLORS.length] }} />
              <span className="text-xs font-medium text-black">{r.name}</span>
              <span className="text-[10px] text-gray-400 ml-auto">{r.mode}</span>
            </div>
            <div className="p-2 bg-gray-50">
              <FreqResponseCanvas
                height={400}
                traces={[
                  // Per-band dashed
                  ...r.bands.map((b, bi) => ({
                    label: b.label,
                    freqs: r.freqs,
                    db: b.db,
                    color: COMPARE_COLORS[i % COMPARE_COLORS.length],
                    width: 1,
                    dashed: true,
                    alpha: 0.45,
                  })),
                  // Combined solid
                  {
                    label: "Combined",
                    freqs: r.freqs,
                    db: r.combined.db,
                    color: COMPARE_COLORS[i % COMPARE_COLORS.length],
                    width: 2.5,
                  },
                ]}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Canvas-based frequency response chart
// ─────────────────────────────────────────────────────────────────────────────

interface Trace {
  label: string;
  freqs: number[];
  db: number[];
  color: string;
  width: number;
  dashed?: boolean;
  alpha?: number;
}

function FreqResponseCanvas({ traces, height = 280 }: { traces: Trace[]; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    
    // Set actual pixel size accounting for device pixel ratio
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);  // scale all drawing by dpr
    
    const W = rect.width;
    const H = rect.height;
    
    const PAD = { top: 16, right: 16, bottom: 36, left: 48 };
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;

    const DB_MIN = -72;
    const DB_MAX = 24;
    const FREQ_MIN = 20;
    const FREQ_MAX = 20000;

    const freqToX = (f: number) =>
      PAD.left + (Math.log10(f / FREQ_MIN) / Math.log10(FREQ_MAX / FREQ_MIN)) * plotW;

    const dbToY = (db: number) =>
      PAD.top + plotH - ((db - DB_MIN) / (DB_MAX - DB_MIN)) * plotH;

    // Clear
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#f9fafb";
    ctx.fillRect(0, 0, W, H);

    // Grid lines — frequency
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 0.7;
    [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].forEach((f) => {
      const x = freqToX(f);
      ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, PAD.top + plotH); ctx.stroke();
    });

    // Grid lines — dB
    [-60, -48, -36, -24, -12, 0, 12, 24].forEach((db) => {
      const y = dbToY(db);
      ctx.strokeStyle = db === 0 ? "#9ca3af" : "#e5e7eb";
      ctx.lineWidth = db === 0 ? 1 : 0.7;
      ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + plotW, y); ctx.stroke();
    });

    // -3 dB dotted
    ctx.strokeStyle = "#d1d5db";
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 0.7;
    const y3 = dbToY(-3);
    ctx.beginPath(); ctx.moveTo(PAD.left, y3); ctx.lineTo(PAD.left + plotW, y3); ctx.stroke();
    ctx.setLineDash([]);

    // Axis labels — dB
    ctx.fillStyle = "#6b7280";
    ctx.font = "9px monospace";
    ctx.textAlign = "right";
    [-60, -36, -12, 0, 12, 24].forEach((db) => {
      ctx.fillText(`${db}`, PAD.left - 4, dbToY(db) + 3);
    });

    // Axis labels — freq
    ctx.textAlign = "center";
    [100, 1000, 10000].forEach((f) => {
      const label = f >= 1000 ? `${f / 1000}k` : String(f);
      ctx.fillText(label, freqToX(f), PAD.top + plotH + 12);
    });

    // Traces
    traces.forEach((trace) => {
      ctx.save();
      ctx.globalAlpha = trace.alpha ?? 1;
      ctx.strokeStyle = trace.color;
      ctx.lineWidth = trace.width;
      if (trace.dashed) ctx.setLineDash([4, 3]);

      ctx.beginPath();
      trace.freqs.forEach((f, i) => {
        const x = freqToX(f);
        const y = dbToY(trace.db[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.restore();
      ctx.setLineDash([]);
    });

    // Legend (top-right inside plot)
    const legendTraces = traces.filter((t) => !t.dashed);
    const lx = PAD.left + plotW - 8;
    let ly = PAD.top + 8;
    ctx.textAlign = "right";
    ctx.font = "9px monospace";
    legendTraces.forEach((t) => {
      ctx.fillStyle = t.color;
      ctx.fillRect(lx - 28, ly - 6, 20, 2);
      ctx.fillStyle = "#374151";
      ctx.fillText(t.label, lx - 32, ly);
      ly += 14;
    });
  }, [traces, height]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height: height, display: "block" }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BandCard
// ─────────────────────────────────────────────────────────────────────────────

interface BandCardProps {
  stage: FilterStage;
  index: number;
  onUpdate: (patch: Partial<FilterStage>) => void;
}

function BandCard({ stage, index, onUpdate }: BandCardProps) {
  const isBP = stage.band_type === "bandpass";
  const isBS = stage.band_type === "bandstop";
  const isLP = stage.band_type === "lowpass";
  const isHP = stage.band_type === "highpass";

  return (
    <div className="border border-black bg-white">
      <div className="flex items-center justify-between px-3 py-2 border-b border-black bg-black text-white">
        <span className="text-xs font-medium tracking-wide">Band {index + 1}</span>
      </div>
      <div className="p-3 space-y-3">
        <SelectRow label="Band type" value={stage.band_type} onChange={(v) => onUpdate({ band_type: v as BandType })}>
          <option value="lowpass">Low-pass</option>
          <option value="highpass">High-pass</option>
          <option value="bandpass">Bandpass</option>
          <option value="bandstop">Band-stop (notch)</option>
        </SelectRow>

        {(isLP || isHP) && (
          <>
            <SliderRow label="Cutoff (Hz)" min={20} max={20000} step={1} value={stage.cutoff ?? 1000} onChange={(v) => onUpdate({ cutoff: v })} display={`${stage.cutoff ?? 1000} Hz`} />
            <SliderRow label="Gain (dB)" min={-24} max={24} step={0.5} value={stage.gain_db} onChange={(v) => onUpdate({ gain_db: v })} display={`${stage.gain_db > 0 ? "+" : ""}${stage.gain_db.toFixed(1)} dB`} />
          </>
        )}

        {isBS && (
          <>
            <SliderRow label="Stop low (Hz)" min={20} max={20000} step={1} value={stage.cutoff_low ?? 800} onChange={(v) => onUpdate({ cutoff_low: v })} display={`${stage.cutoff_low ?? 800} Hz`} />
            <SliderRow label="Stop high (Hz)" min={20} max={20000} step={1} value={stage.cutoff_high ?? 1200} onChange={(v) => onUpdate({ cutoff_high: v })} display={`${stage.cutoff_high ?? 1200} Hz`} />
            <SliderRow label="Gain (dB)" min={-24} max={24} step={0.5} value={stage.gain_db} onChange={(v) => onUpdate({ gain_db: v })} display={`${stage.gain_db > 0 ? "+" : ""}${stage.gain_db.toFixed(1)} dB`} />
          </>
        )}

        {isBP && (
          <div className="space-y-2 pt-1">
            <SliderRow label="Center freq (Hz)" min={20} max={20000} step={1} value={stage.bp_fc} onChange={(v) => onUpdate({ bp_fc: v })} display={`${stage.bp_fc} Hz`} />
            <SliderRow label="Bandwidth (oct)" min={0.1} max={3} step={0.05} value={stage.bp_bandwidth_oct} onChange={(v) => onUpdate({ bp_bandwidth_oct: v })} display={`${stage.bp_bandwidth_oct.toFixed(2)} oct`} />
            <SliderRow label="Gain (dB)" min={-18} max={18} step={0.5} value={stage.bp_gain_db} onChange={(v) => onUpdate({ bp_gain_db: v })} display={`${stage.bp_gain_db > 0 ? "+" : ""}${stage.bp_gain_db.toFixed(1)} dB`} />
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border border-black bg-white">
      <div className="px-3 py-1.5 border-b border-black bg-black text-white">
        <span className="text-xs font-medium tracking-wide">{label}</span>
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

function SegmentedControl({ options, value, onChange }: { options: { label: string; value: string }[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex border border-black overflow-hidden">
      {options.map((opt) => (
        <button key={opt.value} onClick={() => onChange(opt.value)} className={`flex-1 py-1.5 text-xs font-medium transition-colors ${value === opt.value ? "bg-black text-white" : "bg-white text-black hover:bg-gray-100"}`}>
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function SelectRow({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</p>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="w-full border border-gray-300 bg-white text-xs px-2 py-1.5 text-black appearance-none">
        {children}
      </select>
    </div>
  );
}

function SliderRow({ label, min, max, step, value, onChange, display }: { label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void; display: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = () => { setDraft(String(value)); setEditing(true); setTimeout(() => inputRef.current?.select(), 0); };
  const commit = () => { const p = parseFloat(draft); if (!isNaN(p)) onChange(Math.min(max, Math.max(min, p))); setEditing(false); };
  const onKeyDown = (e: React.KeyboardEvent) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); };

  return (
    <div className="space-y-0.5">
      <div className="flex justify-between items-baseline">
        <p className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</p>
        {editing ? (
          <input ref={inputRef} type="number" value={draft} min={min} max={max} step={step} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={onKeyDown} className="text-[10px] font-medium text-black tabular-nums bg-white border-b border-black outline-none w-20 text-right px-0.5" />
        ) : (
          <button onClick={startEdit} title="Click to type a value" className="text-[10px] font-medium text-black tabular-nums hover:text-gray-500 hover:underline underline-offset-2 transition-colors cursor-text">{display}</button>
        )}
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-black" />
    </div>
  );
}