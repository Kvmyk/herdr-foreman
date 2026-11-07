"""Quiet ambient pad with keyboard foley for the foreman demo video.

Synthesised from scratch with numpy/scipy — no samples, no licensing questions.
Key clicks and Enter thuds are synced to the typing events in demo.py.

    python media/src/music.py out.wav               # default 37.4 s (16:9)
    python media/src/music.py out.wav --linkedin     # 30 s (LinkedIn cut)
    python media/src/music.py out.wav --length 40    # custom length
"""
import sys

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, fftconvolve, sosfilt

SR = 44100
rng = np.random.default_rng(42)


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def filt(sig, kind, cutoff, order=2):
    return sosfilt(butter(order, cutoff, btype=kind, fs=SR, output='sos'), sig)


def env(n, attack, release, sustain=1.0, decay=0.0):
    t = np.arange(n) / SR
    e = np.minimum(1.0, t / max(attack, 1e-4))
    if decay:
        e = np.where(t > attack, sustain + (1 - sustain) * np.exp(-(t - attack) / decay), e)
    tail = int(release * SR)
    if tail and tail < n:
        e[-tail:] *= np.linspace(1, 0, tail)
    return e


# ---------------------------------------------------------------- ambient pad
# Very slow, breathy, detuned pad — Am chord tones only, no progression.
# Intentionally static and unobtrusive.

PAD_NOTES = [57, 60, 64, 69]  # A3, C4, E4, A4


def pad_voice(freq, dur, harmonics=4):
    """A single breathy, detuned voice."""
    t = np.arange(int(dur * SR)) / SR
    out = np.zeros_like(t)
    for k in range(1, harmonics + 1):
        if k * freq > 12000:
            break
        # Gentle detuning for warmth
        detune = 1.0 + rng.uniform(-0.003, 0.003)
        out += np.sin(2 * np.pi * k * freq * detune * t) / (k ** 1.5)
    return out


def render_pad(length):
    """Two-channel ambient pad for the full duration."""
    n = int(length * SR) + SR
    buf = np.zeros((2, n))

    for note in PAD_NOTES:
        for cents, pan in [(-6, -0.4), (0, 0.0), (6, 0.4)]:
            freq = hz(note) * 2 ** (cents / 1200)
            sig = pad_voice(freq, length + 1, harmonics=4)
            e = env(len(sig), 2.0, 3.0, sustain=0.8, decay=1.0)
            sig *= e * 0.025  # Very quiet

            left = np.cos((pan + 1) * np.pi / 4)
            right = np.sin((pan + 1) * np.pi / 4)
            m = min(len(sig), n)
            buf[0, :m] += sig[:m] * left
            buf[1, :m] += sig[:m] * right

    # Lowpass to keep it muted and warm
    buf = np.stack([filt(ch, 'lowpass', 2500, order=3) for ch in buf])
    return buf


# ---------------------------------------------------------------- keyboard foley
# Synthesised key clicks (short filtered noise burst) and Enter thuds
# (lower, slightly longer noise burst).

def key_click():
    """A single mechanical key click — short high-frequency transient."""
    n = int(0.025 * SR)
    noise = rng.standard_normal(n)
    filtered = filt(noise, 'bandpass', [2000, 8000], order=2)
    e = np.exp(-np.arange(n) / SR * 200)
    return filtered * e * 0.6


def enter_thud():
    """A heavier Enter key — lower frequency, slightly longer."""
    n = int(0.06 * SR)
    noise = rng.standard_normal(n)
    filtered = filt(noise, 'bandpass', [400, 3000], order=2)
    e = np.exp(-np.arange(n) / SR * 60)
    # Add a subtle low thump
    t = np.arange(n) / SR
    thump = np.sin(2 * np.pi * 80 * t) * np.exp(-t * 40) * 0.3
    return (filtered * e * 0.5 + thump)


def place(buf, start, sig, pan=0.0, gain=1.0):
    i = int(start * SR)
    n = min(len(sig), buf.shape[1] - i)
    if n <= 0:
        return
    left = np.cos((pan + 1) * np.pi / 4)
    right = np.sin((pan + 1) * np.pi / 4)
    buf[0, i:i + n] += sig[:n] * gain * left
    buf[1, i:i + n] += sig[:n] * gain * right


def render_foley(length, typing_events):
    """Place key clicks and Enter thuds at typing event times."""
    n = int(length * SR) + SR
    buf = np.zeros((2, n))

    for t, ch in typing_events:
        if t >= length:
            break
        if ch == '\n':
            sig = enter_thud()
            place(buf, t, sig, rng.uniform(-0.1, 0.1), 0.35)
        else:
            sig = key_click()
            # Slight random pan and velocity variation
            pan = rng.uniform(-0.15, 0.15)
            vel = rng.uniform(0.15, 0.30)
            place(buf, t, sig, pan, vel)

    return buf


# ---------------------------------------------------------------- typing events from demo.py timeline

def _typing_events_16x9():
    """Hardcoded typing events matching demo.py timeline."""
    events = []
    typed_lines = [
        # (start_time, text, cps)
        (0.2 + 0.25, 'foreman "fix payment security holes"', 15),
        (7.5 + 0.25, f'foreman spawn --task fix-payment-security-holes …', 34),
        (18.0 + 0.25, '1, 2 and 3 yes, 4 no', 15),
        (27.6 + 0.25, '1', 6),
    ]
    for start, text, cps in typed_lines:
        for i, ch in enumerate(text):
            events.append((start + i / cps, ch))
        events.append((start + len(text) / cps + 0.05, '\n'))
    return events


def _typing_events_linkedin():
    """Remap 16:9 events to LinkedIn timeline."""
    from demo import _remap_li
    events_16x9 = _typing_events_16x9()
    events = []
    for t, ch in events_16x9:
        events.append((_remap_li(t), ch))
    return events


# ---------------------------------------------------------------- reverb

def add_reverb(buf, wet=0.15):
    """Simple convolution reverb with a short decaying noise IR."""
    ir_len = int(0.8 * SR)
    ir_t = np.arange(ir_len) / SR
    ir = np.stack([
        filt(rng.standard_normal(ir_len), 'lowpass', 4000) * np.exp(-ir_t / 0.25)
        for _ in range(2)
    ])
    ir /= np.abs(ir).sum(axis=1, keepdims=True) / 4
    reverb = np.stack([fftconvolve(buf[c], ir[c])[:buf.shape[1]] for c in range(2)])
    return buf + reverb * wet


# ---------------------------------------------------------------- main

def render(length=37.4, is_linkedin=False):
    pad = render_pad(length)

    if is_linkedin:
        try:
            events = _typing_events_linkedin()
        except Exception:
            events = _typing_events_16x9()
    else:
        events = _typing_events_16x9()

    foley = render_foley(length, events)

    # Mix: pad is the bed, foley on top
    mix = pad + foley
    mix = add_reverb(mix, wet=0.12)

    # Gentle highpass to remove DC
    mix = np.stack([filt(ch, 'highpass', 30) for ch in mix])

    # Soft limiting
    mix = np.tanh(mix * 1.5) / np.tanh(1.5)
    n = int(length * SR)
    mix = mix[:, :n]

    # Fade in/out
    fade_in = int(0.1 * SR)
    fade_out = int(2.0 * SR)
    mix[:, :fade_in] *= np.linspace(0, 1, fade_in)
    mix[:, -fade_out:] *= np.linspace(1, 0, fade_out) ** 1.5

    return mix / max(np.abs(mix).max(), 1e-6) * 0.7


if __name__ == '__main__':
    is_linkedin = '--linkedin' in sys.argv
    argv = [a for a in sys.argv[1:] if a != '--linkedin']

    length = 37.4
    if is_linkedin:
        length = 30.0
    if '--length' in argv:
        i = argv.index('--length')
        length = float(argv[i + 1])
        argv = argv[:i] + argv[i + 2:]

    out = argv[0] if argv else 'music.wav'
    audio = render(length=length, is_linkedin=is_linkedin)
    wavfile.write(out, SR, (audio.T * 32767).astype(np.int16))
    rms = 20 * np.log10(np.sqrt((audio ** 2).mean()) + 1e-10)
    print(f'{out}: {length:.0f} s, peak {20 * np.log10(np.abs(audio).max() + 1e-10):.0f} dBFS, RMS {rms:.1f} dBFS')
