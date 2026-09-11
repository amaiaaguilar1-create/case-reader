"""Estimate per-word timings within a synthesized chunk.

kokoro-onnx does not expose token durations (validated), so we distribute the
measured audio duration across words proportionally to a speech-weight:
letters count fully, punctuation adds pause weight, and each word gets a
small fixed cost (articulation floor).
"""
from __future__ import annotations
from .model import Word

_PAUSE_PUNCT = {",": 3.0, ";": 4.0, ":": 4.0, ".": 6.0, "!": 6.0, "?": 6.0, "\u2014": 4.0}
_WORD_FLOOR = 2.0  # fixed weight per word


def _weight(word: str) -> float:
    w = _WORD_FLOOR + sum(1.0 for c in word if c.isalnum())
    w += sum(_PAUSE_PUNCT.get(c, 0.0) for c in word)
    return w


def estimate_word_timings(words: list[Word], audio_duration: float) -> list[tuple[float, float]]:
    """Return [(start_sec, end_sec)] per word, monotonic, covering [0, duration]."""
    if not words:
        return []
    weights = [_weight(w.text) for w in words]
    total = sum(weights) or 1.0
    timings, t = [], 0.0
    for wt in weights:
        dur = audio_duration * (wt / total)
        timings.append((t, t + dur))
        t += dur
    # snap final end to exact duration (float drift)
    s, _ = timings[-1]
    timings[-1] = (s, audio_duration)
    return timings
