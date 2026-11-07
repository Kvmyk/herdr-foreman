"""Original 40-second backing track for the foreman demo video.

120 BPM, A minor (Am - F - C - G), synthesised from scratch with numpy, so
there are no samples and no licensing questions. Usage:

    python media/src/music.py out.wav
"""
import sys

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, fftconvolve, sosfilt

SR = 44100
BEAT = 0.5           # 120 BPM
BAR = 4 * BEAT
BARS = 20
LENGTH = BARS * BAR  # 40 s
rng = np.random.default_rng(7)

CHORDS = [[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]]  # Am F C G
BASS = [45, 41, 48, 43]


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def track():
    return np.zeros((2, int(LENGTH * SR) + SR))


def place(buf, start, sig, pan=0.0, gain=1.0):
    i = int(start * SR)
    n = min(len(sig), buf.shape[1] - i)
    if n <= 0:
        return
    left, right = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    buf[0, i:i + n] += sig[:n] * gain * left
    buf[1, i:i + n] += sig[:n] * gain * right


def env(n, attack, release, sustain=1.0, decay=0.0):
    t = np.arange(n) / SR
    e = np.minimum(1.0, t / max(attack, 1e-4))
    if decay:
        e = np.where(t > attack, sustain + (1 - sustain) * np.exp(-(t - attack) / decay), e)
    tail = int(release * SR)
    if tail and tail < n:
        e[-tail:] *= np.linspace(1, 0, tail)
    return e


def additive(freq, dur, harmonics, odd=False, vibrato=0.0):
    t = np.arange(int(dur * SR)) / SR
    phase = 2 * np.pi * freq * t
    if vibrato:
        phase += vibrato * np.sin(2 * np.pi * 5.5 * t) * np.clip((t - 0.15) * 4, 0, 1)
    out = np.zeros_like(t)
    for k in range(1, harmonics + 1):
        if odd and k % 2 == 0:
            continue
        if k * freq > 16000:
            break
        out += np.sin(k * phase) / k
    return out


def filt(sig, kind, cutoff, order=2):
    return sosfilt(butter(order, cutoff, btype=kind, fs=SR, output='sos'), sig)


def kick():
    t = np.arange(int(0.4 * SR)) / SR
    f = 46 + 120 * np.exp(-t * 32)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 7)
    click = filt(rng.standard_normal(len(t)), 'highpass', 2000) * np.exp(-t * 400) * 0.3
    return np.tanh(1.6 * (body + click))


def hat(length=0.06):
    n = int(length * SR)
    return filt(rng.standard_normal(n), 'highpass', 7000) * np.exp(-np.arange(n) / SR * 70)


def clap():
    n = int(0.25 * SR)
    t = np.arange(n) / SR
    noise = filt(rng.standard_normal(n), 'bandpass', [900, 3200])
    bursts = sum(np.exp(-np.clip(t - d, 0, None) * 120) * (t >= d) for d in (0, 0.011, 0.022))
    return noise * (bursts * 0.5 + np.exp(-t * 18) * (t >= 0.022))


def pluck(midi, dur=0.22):
    n = int(dur * SR)
    t = np.arange(n) / SR
    return additive(hz(midi), dur, 6) * np.exp(-t * 14) * env(n, 0.003, 0.02)


def section(bar):
    if bar < 2:
        return 'intro'
    if bar < 10:
        return 'groove'
    if bar < 18:
        return 'full'
    return 'outro'


LEAD = [  # (beat, midi, beats) per bar, played in bars 10-15
    [(0, 76, 1), (1, 74, 0.5), (1.5, 72, 0.5), (2, 69, 1), (3, 72, 0.5), (3.5, 74, 0.5)],
    [(0, 72, 1), (1, 69, 1), (2, 72, 0.5), (2.5, 74, 0.5), (3, 76, 1)],
    [(0, 79, 1), (1, 76, 0.5), (1.5, 74, 0.5), (2, 76, 1), (3, 72, 1)],
    [(0, 74, 2), (2, 71, 1), (3, 74, 1)],
    [(0, 76, 1), (1, 74, 0.5), (1.5, 72, 0.5), (2, 69, 1), (3, 72, 0.5), (3.5, 74, 0.5)],
    [(0, 72, 1), (1, 74, 1), (2, 76, 2)],
]


def render():
    drums, bass, pads, arps, lead, send = (track() for _ in range(6))
    kicks = []

    for bar in range(BARS):
        start = bar * BAR
        chord = CHORDS[bar % 4]
        part = section(bar)
        last = bar == BARS - 1

        # pad: three detuned voices per note, brighter after the intro
        dur = BAR * (2.2 if last else 1.15)
        harmonics = 4 + bar * 2 if part == 'intro' else 9
        for note in chord:
            for cents, pan in ((-9, -0.6), (0, 0.0), (9, 0.6)):
                sig = additive(hz(note) * 2 ** (cents / 1200), dur, harmonics)
                place(pads, start, sig * env(len(sig), 0.35, 0.8), pan, 0.045)

        if part in ('groove', 'full') or bar == 18:
            hits = [0] if bar == 18 else range(4)
            for b in hits:
                place(drums, start + b * BEAT, kick(), 0, 0.9)
                kicks.append(start + b * BEAT)

        if part in ('groove', 'full'):
            for b in range(4):
                place(drums, start + b * BEAT + BEAT / 2, hat(0.08), 0.25, 0.22)
                if part == 'full':
                    place(drums, start + b * BEAT + BEAT / 4, hat(), -0.2, 0.09)
                    place(drums, start + b * BEAT + 3 * BEAT / 4, hat(), -0.2, 0.09)
            if part == 'full':
                for b in (1, 3):
                    place(drums, start + b * BEAT, clap(), 0.05, 0.35)
                    place(send, start + b * BEAT, clap(), 0, 0.12)

            # bass: eighth notes, octave jump on the last one
            for e in range(8):
                note = BASS[bar % 4] + (12 if e == 7 else 0)
                d = BEAT / 2 * 0.9
                sig = additive(hz(note), d, 7) * 0.6 + np.sin(2 * np.pi * hz(note - 12) * np.arange(int(d * SR)) / SR)
                place(bass, start + e * BEAT / 2, sig * env(len(sig), 0.005, 0.04, 0.6, 0.12), 0, 0.28)

            # arpeggio: sixteenths over the chord, ping-pong in stereo
            tones = [chord[0] + 12, chord[1] + 12, chord[2] + 12, chord[0] + 24]
            pattern = [0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 2, 1, 2, 1]
            for s, idx in enumerate(pattern):
                sig = pluck(tones[idx])
                level = 0.10 if part == 'groove' else 0.08
                place(arps, start + s * BEAT / 4, sig, -0.35 if s % 2 else 0.35, level)
                place(send, start + s * BEAT / 4, sig, 0, level * 0.5)

        if 10 <= bar < 16:
            for beat, note, beats in LEAD[bar - 10]:
                d = beats * BEAT
                sig = additive(hz(note), d, 9, odd=True, vibrato=0.25)
                sig *= env(len(sig), 0.01, min(0.12, d / 3), 0.75, 0.2)
                place(lead, start + beat * BEAT, sig, 0, 0.11)
                place(send, start + beat * BEAT, sig, 0, 0.07)

        if bar in (1, 17):  # riser into the next section
            n = int(BAR * SR)
            sweep = filt(rng.standard_normal(n), 'highpass', 1500) * np.linspace(0, 1, n) ** 2
            place(drums, start, sweep, 0, 0.12)

    # sidechain: duck the tonal parts under every kick
    t = np.arange(pads.shape[1]) / SR
    duck = np.ones_like(t)
    for k in kicks:
        i = int(k * SR)
        tail = np.arange(int(0.35 * SR)) / SR
        j = min(len(duck), i + len(tail))
        duck[i:j] = np.minimum(duck[i:j], 1 - 0.65 * np.exp(-tail[:j - i] / 0.09))
    tonal = (pads + bass + arps) * duck

    # reverb: convolution with a decaying noise tail
    ir_t = np.arange(int(1.8 * SR)) / SR
    ir = np.stack([filt(rng.standard_normal(len(ir_t)), 'lowpass', 6000) * np.exp(-ir_t / 0.45) for _ in range(2)])
    ir /= np.abs(ir).sum(axis=1, keepdims=True) / 6
    wet = np.stack([fftconvolve(send[c] + pads[c] * 0.6, ir[c])[:send.shape[1]] for c in range(2)])

    mix = drums + tonal + lead + wet * 0.35
    mix = np.stack([filt(ch, 'highpass', 30) for ch in mix])
    mix = np.tanh(mix * 1.3) / np.tanh(1.3)
    mix = mix[:, :int(LENGTH * SR)]

    fade_in, fade_out = int(0.05 * SR), int(3.0 * SR)
    mix[:, :fade_in] *= np.linspace(0, 1, fade_in)
    mix[:, -fade_out:] *= np.linspace(1, 0, fade_out) ** 1.5
    return mix / np.abs(mix).max() * 0.89


if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else 'music.wav'
    audio = render()
    wavfile.write(out, SR, (audio.T * 32767).astype(np.int16))
    rms = 20 * np.log10(np.sqrt((audio ** 2).mean()))
    print(f'{out}: {LENGTH:.0f} s, peak -1 dBFS, RMS {rms:.1f} dBFS')
