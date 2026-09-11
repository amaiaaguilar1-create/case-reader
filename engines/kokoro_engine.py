"""TTS engine with curated voice presets (single voices + warm blends).

Design decisions, validated in-sandbox:
- kokoro-onnx exposes no word timings -> proportional estimation (core.timing).
- Style vectors (510,1,256) blend linearly -> richer timbre via weighted mixes.
- Synthesis always runs at the preset's base prosody speed; user speed is applied
  client-side via playbackRate (pitch-preserved). One cache entry per voice.
- Kokoro is not thread-safe -> a lock guards create(); the server serializes
  synthesis through one worker anyway.
"""
from __future__ import annotations

import hashlib
import threading
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

from core.model import Word
from core.timing import estimate_word_timings


@dataclass(frozen=True)
class VoicePreset:
    id: str
    label: str
    blend: dict[str, float]  # kokoro voice -> weight
    base_speed: float        # prosody baked into synthesis


# Preset roster validated in-sandbox on the fp32 model (24/24 voice x text
# stability matrix + blend matrix all pass). Blended style vectors are stable
# on fp32 but numerically explode on the int8 model for some voice/text pairs
# (speech collapses, tail spikes to float-max), so blends require fp32.
PRESETS: dict[str, VoicePreset] = {p.id: p for p in [
    VoicePreset("aria",   "Aria \u00b7 warm",        {"af_heart": 0.6, "af_bella": 0.4}, 0.93),
    VoicePreset("river",  "River \u00b7 calm",       {"af_heart": 0.5, "af_nicole": 0.5}, 0.91),
    VoicePreset("sky",    "Sky \u00b7 bright",       {"af_sky": 1.0},                    1.00),
    VoicePreset("emma",   "Emma \u00b7 storyteller", {"bf_emma": 1.0},                   0.93),
    VoicePreset("george", "George \u00b7 rich",      {"bm_george": 1.0},                 0.95),
    VoicePreset("adam",   "Adam \u00b7 deep",        {"am_liam": 0.7, "am_michael": 0.3}, 0.95),
]}
DEFAULT_PRESET = "aria"


def _postprocess(samples: np.ndarray, sr: int,
                 thresh_db: float = -42.0, pad_ms: int = 60) -> np.ndarray:
    """De-click, normalize, and trim silence.

    The int8 Kokoro model occasionally emits 1-2 sample transients hundreds of
    times louder than speech (peak 337 observed vs speech ~0.18). Those spikes
    clip on playback and break any peak-relative silence threshold, so:
    1. clip to 1.5x the 99.9th-percentile envelope (kills the spike, leaves speech)
    2. peak-normalize to 0.92 for consistent loudness across voices
    3. trim edges against a threshold relative to the *post-declick* peak
    """
    if samples.size == 0:
        return samples
    clean = np.nan_to_num(samples.astype(np.float64), nan=0.0,
                          posinf=0.0, neginf=0.0)
    env = np.abs(clean)
    ref = np.percentile(env, 99.9)
    if ref == 0.0:
        return clean.astype(np.float32)
    clipped = np.clip(clean, -1.5 * ref, 1.5 * ref)
    clipped *= 0.92 / np.abs(clipped).max()
    env = np.abs(clipped)
    idx = np.nonzero(env > env.max() * (10 ** (thresh_db / 20)))[0]
    if idx.size == 0:
        return clipped.astype(np.float32)
    pad = int(sr * pad_ms / 1000)
    lo, hi = max(0, idx[0] - pad), min(clipped.size, idx[-1] + pad)
    return clipped[lo:hi].astype(np.float32)


@dataclass
class SynthesisResult:
    wav_path: Path
    duration: float
    sample_rate: int
    word_timings: list[tuple[float, float]]


class TTSEngine(ABC):
    @abstractmethod
    def presets(self) -> list[VoicePreset]: ...

    @abstractmethod
    def synthesize(self, text: str, words: list[Word], preset_id: str) -> SynthesisResult: ...


class KokoroEngine(TTSEngine):
    def __init__(self, model_path: str, voices_path: str, cache_dir: str = "cache"):
        from kokoro_onnx import Kokoro
        self._k = Kokoro(model_path, voices_path)
        self._lock = threading.Lock()
        self._styles: dict[str, np.ndarray] = {}
        self._cache = Path(cache_dir)
        self._cache.mkdir(exist_ok=True)

    def presets(self) -> list[VoicePreset]:
        return list(PRESETS.values())

    def _style(self, preset: VoicePreset) -> np.ndarray:
        if preset.id not in self._styles:
            mix = sum(self._k.get_voice_style(v) * w for v, w in preset.blend.items())
            self._styles[preset.id] = mix.astype(np.float32)
        return self._styles[preset.id]

    def cache_path(self, text: str, preset_id: str) -> Path:
        h = hashlib.sha256(f"kokoro|{preset_id}|{text}".encode()).hexdigest()[:24]
        return self._cache / f"{h}.wav"

    def is_cached(self, text: str, preset_id: str) -> bool:
        return self.cache_path(text, preset_id).exists()

    def synthesize(self, text: str, words: list[Word], preset_id: str) -> SynthesisResult:
        preset = PRESETS.get(preset_id) or PRESETS[DEFAULT_PRESET]
        wav = self.cache_path(text, preset.id)
        if wav.exists():
            info = sf.info(str(wav))
            duration, sr = info.duration, info.samplerate
        else:
            with self._lock:
                # trim=False: kokoro-onnx's trimmer squares float16 energy,
                # overflows to inf on blended styles, and can trim the entire
                # clip to zero samples (reproduced in-sandbox). We trim ourselves.
                samples, sr = self._k.create(text, voice=self._style(preset),
                                             speed=preset.base_speed, trim=False)
            samples = _postprocess(np.asarray(samples, dtype=np.float32), sr)
            tmp = wav.with_suffix(".tmp.wav")
            sf.write(str(tmp), samples, sr)
            tmp.rename(wav)  # atomic publish; readers never see partial files
            duration = len(samples) / sr
        return SynthesisResult(wav, duration, sr, estimate_word_timings(words, duration))
