import numpy as np
from engines.kokoro_engine import PAD_MS, _postprocess

SR = 24000

def test_speech_kept_and_padded():
    sig = np.zeros(SR * 3, dtype=np.float32)
    sig[SR:2*SR] = 0.5
    out = _postprocess(sig, SR)
    assert SR <= out.size <= SR + 2 * int(SR * PAD_MS / 1000) + 2

def test_transient_spike_does_not_destroy_trim():
    # regression: int8 model emits huge 1-sample spikes (observed peak 337)
    rng = np.random.default_rng(0)
    sig = np.zeros(SR * 3, dtype=np.float32)
    sig[SR:2*SR] = (0.15 * np.sin(np.linspace(0, 800*np.pi, SR))).astype(np.float32)
    sig[10] = 337.0
    out = _postprocess(sig, SR)
    assert out.size >= SR * 0.9          # speech survives
    assert np.abs(out).max() <= 0.93     # spike gone, normalized

def test_normalization_target():
    sig = np.zeros(SR, dtype=np.float32); sig[:] = 0.01
    out = _postprocess(sig, SR)
    assert 0.9 <= np.abs(out).max() <= 0.93

def test_empty_and_silent():
    assert _postprocess(np.array([], dtype=np.float32), SR).size == 0
    assert _postprocess(np.zeros(1000, dtype=np.float32), SR).size == 1000

def test_nan_inf_samples_survive():
    sig = np.zeros(SR, dtype=np.float32)
    sig[100:200] = 0.3
    sig[50] = np.nan; sig[60] = np.inf
    out = _postprocess(sig, SR)
    assert np.isfinite(out).all() and out.size > 0
