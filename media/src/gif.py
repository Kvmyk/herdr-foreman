"""Build an optimised GIF from the 16:9 demo MP4 for the README.

Two-pass ffmpeg palettegen/paletteuse, 12 fps, 820 px wide (matching
README width=820), terminal scene only (skips the outro), target ≤ 3 MB.

    python media/src/gif.py media/demo.mp4 media/demo.gif
"""
import os
import subprocess
import shutil
import sys


def main():
    if len(sys.argv) < 3:
        sys.exit('usage: python media/src/gif.py <input.mp4> <output.gif>')
    inp, out = sys.argv[1], sys.argv[2]
    ffmpeg = shutil.which('ffmpeg') or sys.exit('ffmpeg not found on PATH')

    # Terminal scene runs 0 – ~35.4 s in the 16:9 cut (outro starts at 35.4)
    # We trim to 0–35 s to avoid the fade-to-outro.
    duration = '35'

    palette = out + '.palette.png'

    filters = f'fps=12,scale=820:-1:flags=lanczos'

    # Pass 1: generate palette
    subprocess.run([
        ffmpeg, '-y', '-loglevel', 'error',
        '-t', duration, '-i', inp,
        '-vf', f'{filters},palettegen=max_colors=192:stats_mode=diff',
        palette,
    ], check=True)

    # Pass 2: apply palette
    subprocess.run([
        ffmpeg, '-y', '-loglevel', 'error',
        '-t', duration, '-i', inp,
        '-i', palette,
        '-filter_complex', f'{filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4',
        '-loop', '0',
        out,
    ], check=True)

    # Clean up
    if os.path.exists(palette):
        os.remove(palette)

    size = os.path.getsize(out)
    print(f'{out}: {size / 1024 / 1024:.1f} MB')
    if size > 3 * 1024 * 1024:
        print(f'WARNING: {size / 1024 / 1024:.1f} MB exceeds 3 MB target')


if __name__ == '__main__':
    main()
