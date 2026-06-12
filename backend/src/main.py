import io
import os
import json
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from scipy import signal
from typing import Optional, Literal
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, model_validator
from fastapi.middleware.cors import CORSMiddleware

import psycopg2
from psycopg2.extras import RealDictCursor
from contextlib import contextmanager


app = FastAPI(title="Filter Designer API", version="6.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─────────────────────────────────────────────────────────────────────────────
# Database
# ─────────────────────────────────────────────────────────────────────────────

DB_DSN = os.getenv(
    "DATABASE_URL",
    "postgresql://skripzi:skripzi@db:5432/skripzi",
)


@contextmanager
def get_db():
    conn = psycopg2.connect(DB_DSN, cursor_factory=RealDictCursor)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# Models
# ─────────────────────────────────────────────────────────────────────────────

class Band(BaseModel):
    """
    One frequency band. The required fields depend on band_type:

      lowpass / highpass → cutoff (Hz)
      bandstop           → cutoff_low + cutoff_high (Hz)
      bandpass           → fc + bandwidth_oct (Hz / Hz bandwidth)
    """
    band_type:     Literal["lowpass", "highpass", "bandpass", "bandstop"]
    gain_db:       float           = 0.0
    # lowpass / highpass
    cutoff:        Optional[float] = None
    # bandstop
    cutoff_low:    Optional[float] = None
    cutoff_high:   Optional[float] = None
    # bandpass
    fc:            Optional[float] = None
    bandwidth_oct: Optional[float] = None

    @model_validator(mode="after")
    def check_fields(self):
        bt = self.band_type
        if bt in ("lowpass", "highpass") and self.cutoff is None:
            raise ValueError(f"'{bt}' requires cutoff")
        if bt == "bandstop":
            if self.cutoff_low is None or self.cutoff_high is None:
                raise ValueError("'bandstop' requires cutoff_low and cutoff_high")
            if self.cutoff_low >= self.cutoff_high:
                raise ValueError("cutoff_low must be < cutoff_high")
        if bt == "bandpass":
            if self.fc is None:
                raise ValueError("'bandpass' requires fc")
            if self.bandwidth_oct is None:
                self.bandwidth_oct = 200
        return self

    def bp_edges(self) -> tuple[float, float]:
        half = self.bandwidth_oct / 2.0   # bandwidth_oct now stores Hz
        low  = self.fc - half
        high = self.fc + half
        return max(low, 1.0), max(high, low + 1.0)


class ChainRequest(BaseModel):
    """
    Single unified filter request.
    """
    filter_structure: Literal["IIR", "FIR"] = "IIR"
    filter_type:      str                    = "butter"
    order:            int                    = 4
    mode:             Literal["cascade", "parallel"] = "cascade"
    output_format:    Literal["sos", "ab"]           = "sos"
    fs:               float                  = 44100
    bands:            list[Band]

    @model_validator(mode="after")
    def check_bands(self):
        if not self.bands:
            raise ValueError("bands must not be empty")
        return self


class PresetSave(BaseModel):
    """Body for saving a filter preset."""
    name:        str
    description: Optional[str] = None
    config:      ChainRequest


class PresetResponse(BaseModel):
    """What we return when listing / loading a preset."""
    id:          int
    name:        str
    description: Optional[str]
    config:      dict
    created_at:  str


# ─────────────────────────────────────────────────────────────────────────────
# DSP helpers
# ─────────────────────────────────────────────────────────────────────────────

_BTYPE_MAP = {
    "lowpass":  "low",
    "highpass": "high",
    "bandpass": "bandpass",
    "bandstop": "bandstop",
}


def _norm(hz: float, nyq: float, lo: float = 1e-4, hi: float = 0.9999) -> float:
    return float(np.clip(hz / nyq, lo, hi))


def design_one(filter_structure: str, filter_type: str, order: int,
               cutoff_norm, band_type: str, output_format: str):
    btype = _BTYPE_MAP[band_type]

    if filter_structure == "FIR":
        pass_zero = btype in ("low", "bandstop")
        b = signal.firwin(order + 1, cutoff_norm, pass_zero=pass_zero)
        return ("fir", b)

    out = "sos" if output_format == "sos" else "ba"
    if filter_type == "butter":
        coeffs = signal.butter(order, cutoff_norm, btype=btype, output=out)
    elif filter_type == "cheby1":
        coeffs = signal.cheby1(order, 1, cutoff_norm, btype=btype, output=out)
    elif filter_type == "ellip":
        coeffs = signal.ellip(order, 1, 60, cutoff_norm, btype=btype, output=out)
    elif filter_type == "bessel":
        coeffs = signal.bessel(order, cutoff_norm, btype=btype, output=out, norm="phase")
    else:
        raise ValueError(f"Unknown filter_type: '{filter_type}'")

    return ("sos" if output_format == "sos" else "ab", coeffs)


def band_h(band: Band, req: ChainRequest, w_plot: np.ndarray) -> np.ndarray:
    nyq = req.fs / 2.0

    if band.band_type in ("lowpass", "highpass"):
        cut_n = _norm(band.cutoff, nyq)
        kind, coeffs = design_one(req.filter_structure, req.filter_type,
                                  req.order, cut_n, band.band_type, req.output_format)
    elif band.band_type == "bandstop":
        low_n  = _norm(band.cutoff_low,  nyq, hi=0.9990)
        high_n = _norm(band.cutoff_high, nyq, lo=low_n + 1e-4, hi=0.9999)
        kind, coeffs = design_one(req.filter_structure, req.filter_type,
                                  req.order, [low_n, high_n], "bandstop", req.output_format)
    elif band.band_type == "bandpass":
        low_hz, high_hz = band.bp_edges()
        low_n  = _norm(low_hz,  nyq, hi=0.9990)
        high_n = _norm(high_hz, nyq, lo=low_n + 1e-4, hi=0.9999)
        kind, coeffs = design_one(req.filter_structure, req.filter_type,
                                  req.order, [low_n, high_n], "bandpass", req.output_format)
    else:
        raise HTTPException(422, detail=f"Unknown band_type: '{band.band_type}'")

    if kind == "fir":
        _, h = signal.freqz(coeffs, worN=w_plot, fs=req.fs)
    elif kind == "sos":
        _, h = signal.sosfreqz(coeffs, worN=w_plot, fs=req.fs)
    else:
        b, a = coeffs
        _, h = signal.freqz(b, a, worN=w_plot, fs=req.fs)

    return h


def combine_bands(req: ChainRequest, w_plot: np.ndarray) -> tuple[np.ndarray, list[np.ndarray]]:
    H_list = []
    for i, band in enumerate(req.bands):
        try:
            H_list.append(band_h(band, req, w_plot))
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(500, detail=f"Band {i+1} error: {e}")

    if req.mode == "cascade":
        H_combined = np.ones(len(w_plot), dtype=complex)
        for h in H_list:
            H_combined *= h
    else:
        H_combined = sum(H_list) / len(H_list)

    return H_combined, H_list


def _design_band_zpk(band: Band, req: ChainRequest):
    nyq = req.fs / 2.0
    is_fir = req.filter_structure == "FIR"
    btype_map = {"lowpass":"low","highpass":"high","bandpass":"bandpass","bandstop":"bandstop"}

    if band.band_type in ("lowpass", "highpass"):
        cut_n = _norm(band.cutoff, nyq)
        bt = btype_map[band.band_type]
    elif band.band_type == "bandstop":
        low_n  = _norm(band.cutoff_low,  nyq, hi=0.9990)
        high_n = _norm(band.cutoff_high, nyq, lo=low_n + 1e-4, hi=0.9999)
        cut_n  = [low_n, high_n]
        bt     = "bandstop"
    elif band.band_type == "bandpass":
        low_hz, high_hz = band.bp_edges()
        low_n  = _norm(low_hz,  nyq, hi=0.9990)
        high_n = _norm(high_hz, nyq, lo=low_n + 1e-4, hi=0.9999)
        cut_n  = [low_n, high_n]
        bt     = "bandpass"
    else:
        raise ValueError(f"Unknown band_type: '{band.band_type}'")

    if is_fir:
        pass_zero = bt in ("low", "bandstop")
        b = signal.firwin(req.order + 1, cut_n, pass_zero=pass_zero)
        if band.gain_db != 0.0:
            b = b * (10 ** (band.gain_db / 20.0))
        return None, None, None, b, np.array([1.0])

    design_fn = {
        "butter": lambda: signal.butter(req.order, cut_n, btype=bt, output="zpk"),
        "cheby1": lambda: signal.cheby1(req.order, 1, cut_n, btype=bt, output="zpk"),
        "ellip":  lambda: signal.ellip(req.order, 1, 60, cut_n, btype=bt, output="zpk"),
        "bessel": lambda: signal.bessel(req.order, cut_n, btype=bt, output="zpk", norm="phase"),
    }
    if req.filter_type not in design_fn:
        raise ValueError(f"Unknown filter_type: '{req.filter_type}'")

    z, p, k = design_fn[req.filter_type]()
    if band.gain_db != 0.0:
        k = k * (10 ** (band.gain_db / 20.0))

    b, a = signal.zpk2tf(z, p, k)
    return z, p, k, b, a


def combine_coeffs(req: ChainRequest) -> dict:
    if not req.bands:
        raise HTTPException(422, detail="No bands provided")

    is_fir = req.filter_structure == "FIR"

    try:
        bands = [_design_band_zpk(band, req) for band in req.bands]
    except Exception as e:
        raise HTTPException(500, detail=f"Filter design error: {e}")

    if is_fir:
        if req.mode == "cascade":
            b_out = np.array([1.0])
            for _, _, _, b, _ in bands:
                b_out = np.convolve(b_out, b)
        else:
            max_len = max(len(b) for _, _, _, b, _ in bands)
            b_out = np.zeros(max_len)
            for _, _, _, b, _ in bands:
                b_out[:len(b)] += b
        return {"output_format": "fir", "b": b_out.tolist(), "a": [1.0], "order": len(b_out) - 1}

    if req.mode == "cascade":
        if req.output_format == "sos":
            sos_parts = [signal.zpk2sos(z, p, k) for z, p, k, _, _ in bands]
            sos_out = np.vstack(sos_parts)
            return {"output_format": "sos", "sos": sos_out.tolist(), "shape": list(sos_out.shape)}
        else:
            b_out = np.array([1.0])
            a_out = np.array([1.0])
            for _, _, _, b, a in bands:
                b_out = np.convolve(b_out, b)
                a_out = np.convolve(a_out, a)
            return {"output_format": "ab", "b": b_out.tolist(), "a": a_out.tolist(), "order": len(b_out) - 1}

    a_common = np.array([1.0])
    for _, _, _, _, a in bands:
        a_common = np.convolve(a_common, a)

    b_out = np.zeros(1)
    for i, (_, _, _, b_i, a_i) in enumerate(bands):
        a_others = np.array([1.0])
        for j, (_, _, _, _, a_j) in enumerate(bands):
            if j != i:
                a_others = np.convolve(a_others, a_j)
        contrib = np.convolve(b_i, a_others)
        L = max(len(contrib), len(b_out))
        b_out   = np.pad(b_out,   (0, L - len(b_out)))
        contrib = np.pad(contrib, (0, L - len(contrib)))
        b_out   = b_out + contrib

    if req.output_format == "ab":
        return {"output_format": "ab", "b": b_out.tolist(), "a": a_common.tolist(), "order": len(b_out) - 1}
    else:
        z_out, p_out, k_out = signal.tf2zpk(b_out, a_common)
        sos_out = signal.zpk2sos(z_out, p_out, k_out)
        return {"output_format": "sos", "sos": sos_out.tolist(), "shape": list(sos_out.shape), "order": sos_out.shape[0] * 2}

# ─────────────────────────────────────────────────────────────────────────────
# Plot
# ─────────────────────────────────────────────────────────────────────────────

PALETTE = [
    "#4e79a7", "#f28e2b", "#e15759", "#76b7b2",
    "#59a14f", "#edc948", "#b07aa1", "#ff9da7",
    "#9c755f", "#bab0ac",
]


def _band_label(i: int, band: Band) -> str:
    bt = band.band_type
    if bt == "bandpass":
        return f"B{i+1}: bandpass fc={band.fc:.0f} Hz bw={band.bandwidth_oct:.2f} oct"
    elif bt == "bandstop":
        return f"B{i+1}: bandstop {band.cutoff_low:.0f}–{band.cutoff_high:.0f} Hz"
    else:
        return f"B{i+1}: {bt} {band.cutoff:.0f} Hz"


def render_plot(w_plot: np.ndarray, H_combined: np.ndarray,
                H_list: list[np.ndarray], req: ChainRequest) -> bytes:
    fig, ax = plt.subplots(figsize=(11, 5))

    for i, (h, band) in enumerate(zip(H_list, req.bands)):
        ax.semilogx(
            w_plot, 20 * np.log10(np.abs(h) + 1e-10),
            linewidth=1.3, alpha=0.5, linestyle="--",
            color=PALETTE[i % len(PALETTE)],
            label=_band_label(i, band),
        )

    ax.semilogx(
        w_plot, 20 * np.log10(np.abs(H_combined) + 1e-10),
        linewidth=2.8, color="#111111",
        label=f"Combined ({req.mode})", zorder=10,
    )

    ax.axhline(0,  linestyle="--", linewidth=0.7, color="gray")
    ax.axhline(-3, linestyle=":",  linewidth=0.7, color="gray", alpha=0.5)
    ax.set_xlabel("Frequency (Hz)")
    ax.set_ylabel("Magnitude (dB)")
    ax.set_xlim(20, 20000)
    ax.set_ylim(-72, 24)
    ax.grid(True, which="both", alpha=0.25)
    ax.legend(fontsize=8, loc="lower left", framealpha=0.85)

    n = len(req.bands)
    ftype = "FIR" if req.filter_structure == "FIR" else req.filter_type
    ax.set_title(
        f"{ftype.capitalize()} — {req.mode.upper()}  "
        f"order {req.order}  "
        f"({n} band{'s' if n != 1 else ''})  "
        f"[{req.output_format.upper()}]",
        fontsize=11,
    )
    fig.tight_layout()

    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=130)
    plt.close(fig)
    buf.seek(0)
    return buf.read()


# ─────────────────────────────────────────────────────────────────────────────
# Frequency response helpers (shared by filter endpoints + compare)
# ─────────────────────────────────────────────────────────────────────────────

W_PLOT = np.logspace(np.log10(20), np.log10(20000), 4096)


def _run_simulation(req: ChainRequest) -> dict:
    """Run the DSP simulation and return frequency response data."""
    H_combined, H_list = combine_bands(req, W_PLOT)
    return {
        "freqs":    W_PLOT.tolist(),
        "mode":     req.mode,
        "fs":       req.fs,
        "combined": {"db": (20 * np.log10(np.abs(H_combined) + 1e-10)).tolist()},
        "bands": [
            {
                "label": _band_label(i, b),
                "db":    (20 * np.log10(np.abs(h) + 1e-10)).tolist(),
            }
            for i, (b, h) in enumerate(zip(req.bands, H_list))
        ],
    }


# ─────────────────────────────────────────────────────────────────────────────
# Filter endpoints (unchanged behaviour)
# ─────────────────────────────────────────────────────────────────────────────

@app.post(
    "/filter",
    responses={200: {"content": {"image/png": {}}}},
    response_class=Response,
    summary="Design filter chain → PNG frequency response plot",
)
def api_plot(req: ChainRequest):
    H_combined, H_list = combine_bands(req, W_PLOT)
    return Response(
        content=render_plot(W_PLOT, H_combined, H_list, req),
        media_type="image/png",
    )


@app.post(
    "/filter/data",
    summary="Design filter chain → raw frequency + dB arrays (JSON)",
)
def api_data(req: ChainRequest):
    return _run_simulation(req)


@app.post(
    "/filter/coeffs",
    summary="Design filter chain → ONE combined coefficient set (JSON)",
)
def api_coeffs(req: ChainRequest):
    result = combine_coeffs(req)
    return {
        "filter_structure": req.filter_structure,
        "filter_type":      req.filter_type if req.filter_structure == "IIR" else "fir",
        "order":            req.order,
        "mode":             req.mode,
        "fs":               req.fs,
        "num_bands":        len(req.bands),
        **result,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Preset endpoints  (replaces image-based comparison)
# ─────────────────────────────────────────────────────────────────────────────

@app.post(
    "/presets",
    summary="Save a named filter preset (JSON config only — no image stored)",
    status_code=201,
)
def save_preset(body: PresetSave):
    """
    Persist a filter configuration under a human-readable name.
    The raw ChainRequest JSON is stored; images are never saved.
    Re-run the simulation at any time via GET /presets/{id}/simulate.
    """
    config_json = body.config.model_dump()
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO filter_presets (name, description, config)
                VALUES (%s, %s, %s)
                RETURNING id, name, description,
                          config::text,
                          created_at::text
                """,
                (body.name, body.description, json.dumps(config_json)),
            )
            row = cur.fetchone()
    return {
        "id":          row["id"],
        "name":        row["name"],
        "description": row["description"],
        "config":      json.loads(row["config"]),
        "created_at":  row["created_at"],
    }


@app.get(
    "/presets",
    summary="List all saved filter presets",
)
def list_presets():
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, name, description, config::text, created_at::text
                FROM filter_presets
                ORDER BY created_at DESC
                """
            )
            rows = cur.fetchall()
    return [
        {
            "id":          r["id"],
            "name":        r["name"],
            "description": r["description"],
            "config":      json.loads(r["config"]),
            "created_at":  r["created_at"],
        }
        for r in rows
    ]


@app.get(
    "/presets/{preset_id}",
    summary="Get a single preset by ID",
)
def get_preset(preset_id: int):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, name, description, config::text, created_at::text
                FROM filter_presets WHERE id = %s
                """,
                (preset_id,),
            )
            row = cur.fetchone()
    if not row:
        raise HTTPException(404, detail=f"Preset {preset_id} not found")
    return {
        "id":          row["id"],
        "name":        row["name"],
        "description": row["description"],
        "config":      json.loads(row["config"]),
        "created_at":  row["created_at"],
    }


@app.get(
    "/presets/{preset_id}/simulate",
    summary="Load preset config and run the simulation → frequency response JSON",
)
def simulate_preset(preset_id: int):
    """
    Fetches the stored JSON config, runs the DSP simulation live, and returns
    the frequency response data — same shape as POST /filter/data.
    Nothing is read from or written to disk; the plot is computed on the fly.
    """
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT config::text FROM filter_presets WHERE id = %s",
                (preset_id,),
            )
            row = cur.fetchone()
    if not row:
        raise HTTPException(404, detail=f"Preset {preset_id} not found")

    config_dict = json.loads(row["config"])
    req = ChainRequest(**config_dict)
    result = _run_simulation(req)
    result["preset_id"] = preset_id
    return result


@app.post(
    "/presets/compare",
    summary="Simulate multiple preset IDs and return their responses side-by-side",
)
def compare_presets(preset_ids: list[int]):
    """
    Accepts a list of preset IDs (e.g. [1, 3]).
    For each, loads the JSON config and runs the DSP simulation live.
    Returns a list of simulation results — one per preset — ready for
    the frontend to overlay on a single chart.

    Shared frequency axis: all results use the same W_PLOT grid (20–20 000 Hz).
    """
    if len(preset_ids) < 2:
        raise HTTPException(422, detail="Provide at least 2 preset IDs to compare")
    if len(preset_ids) > 8:
        raise HTTPException(422, detail="Maximum 8 presets can be compared at once")

    results = []
    with get_db() as conn:
        with conn.cursor() as cur:
            for pid in preset_ids:
                cur.execute(
                    "SELECT id, name, description, config::text FROM filter_presets WHERE id = %s",
                    (pid,),
                )
                row = cur.fetchone()
                if not row:
                    raise HTTPException(404, detail=f"Preset {pid} not found")

                config_dict = json.loads(row["config"])
                req = ChainRequest(**config_dict)
                sim = _run_simulation(req)
                results.append({
                    "preset_id":   row["id"],
                    "name":        row["name"],
                    "description": row["description"],
                    **sim,
                })

    return {"presets": results, "freqs": W_PLOT.tolist()}


@app.delete(
    "/presets/{preset_id}",
    summary="Delete a preset by ID",
    status_code=204,
)
def delete_preset(preset_id: int):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM filter_presets WHERE id = %s RETURNING id",
                (preset_id,),
            )
            deleted = cur.fetchone()
    if not deleted:
        raise HTTPException(404, detail=f"Preset {preset_id} not found")
    return Response(status_code=204)
