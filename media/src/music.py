"""Quiet ambient pad with keyboard foley for the foreman demo video.

Synthesised from scratch with numpy/scipy — no samples, no licensing questions.
Key clicks and Enter thuds are synced to the typing events in demo.py, and
the length comes from the cut there.

    python media/src/music.py music.wav              # 16:9 cut
    python media/src/music.py music-li.wav --linkedin  # LinkedIn cut
"""
import sys

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, fftconvolve, sosfilt

import demo

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
# Synthesised key clicks (short filtered noise burst), a softer space bar and
# Enter thuds (lower, slightly longer noise burst).

def key_click():
    """A single mechanical key click — short high-frequency transient."""
    n = int(0.025 * SR)
    noise = rng.standard_normal(n)
    filtered = filt(noise, 'bandpass', [2000, 8000], order=2)
    e = np.exp(-np.arange(n) / SR * 200)
    return filtered * e * 0.6


def space_click():
    """The space bar — lower and softer than a letter key."""
    n = int(0.03 * SR)
    noise = rng.standard_normal(n)
    filtered = filt(noise, 'bandpass', [700, 4000], order=2)
    e = np.exp(-np.arange(n) / SR * 150)
    return filtered * e * 0.5


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
        elif ch == ' ':
            place(buf, t, space_click(), rng.uniform(-0.1, 0.1), rng.uniform(0.12, 0.2))
        else:
            sig = key_click()
            # Slight random pan and velocity variation
            pan = rng.uniform(-0.15, 0.15)
            vel = rng.uniform(0.15, 0.30)
            place(buf, t, sig, pan, vel)

    return buf


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

def render(cut='wide'):
    length = demo.length(cut)
    pad = render_pad(length)
    events = demo.typing_events(cut)
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
    cut = 'linkedin' if '--linkedin' in sys.argv else 'wide'
    argv = [a for a in sys.argv[1:] if a != '--linkedin']
    out = argv[0] if argv else 'music.wav'
    audio = render(cut)
    wavfile.write(out, SR, (audio.T * 32767).astype(np.int16))
    rms = 20 * np.log10(np.sqrt((audio ** 2).mean()) + 1e-10)
    print(f'{out}: {demo.length(cut):.1f} s, peak {20 * np.log10(np.abs(audio).max() + 1e-10):.0f} dBFS, RMS {rms:.1f} dBFS')
