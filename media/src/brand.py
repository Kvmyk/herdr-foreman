"""Render the foreman brand: the crew-hat mark and the GitHub banners.

    python media/src/brand.py                     # logo.svg, logo-512.png, banner.png, banner-light.png
    python media/src/brand.py --check sheet.png   # also a 16/32/64 px contact sheet (default: temp dir)

Needs Pillow and the Cascadia Mono font (Windows). Barlow (SIL OFL) is vendored
in media/src/fonts. Every file is drawn from the numbers below; logo-512.png
has the light brim because demo.py pastes it on a dark background.
"""
import math
import os
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
MEDIA = os.path.join(HERE, '..')
FONT_DIRS = [os.path.join(HERE, 'fonts'),
             os.path.join(os.environ.get('WINDIR', 'C:/Windows'), 'Fonts'),
             os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Microsoft', 'Windows', 'Fonts')]

INK, PAPER, AMBER = (17, 17, 19), (244, 241, 234), (255, 176, 0)
THEMES = {
    # background, brim and wordmark, tagline, mono line, mono accent
    'dark': (INK, PAPER, (190, 186, 178), (140, 138, 132), AMBER),
    'light': (PAPER, INK, (85, 82, 76), (120, 117, 110), (176, 112, 0)),
}

# The mark, on a 512 x 512 grid: a half-disc dome cut by two gaps into three
# segments (one hat, a crew of three) resting on a brim slab.
CX, CY, R = 256, 320, 190           # dome centre and radius; the dome's bottom edge is CY
GAPS, GAP_W = (188, 324), 32        # gap centres and width; 32 is one pixel at 16 px
BRIM = (36, 320, 476, 382)          # x0, y0, x1, y1
BRIM_R = 14
SS = 4                              # supersampling


def hex_(c):
    return '#%02X%02X%02X' % c


def segments():
    """x ranges of the three dome segments."""
    edges = [CX - R] + [e for g in GAPS for e in (g - GAP_W / 2, g + GAP_W / 2)] + [CX + R]
    return [(edges[i], edges[i + 1]) for i in range(0, len(edges), 2)]


def dome_y(x):
    return CY - math.sqrt(max(R * R - (x - CX) ** 2, 0))


def svg():
    paths = []
    for x0, x1 in segments():
        paths.append(f'M{x0:g} {CY} L{x0:g} {dome_y(x0):.2f} A{R} {R} 0 0 1 {x1:g} {dome_y(x1):.2f} L{x1:g} {CY} Z')
    x0, y0, x1, y1 = BRIM
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="foreman">
  <style>.brim {{ fill: {hex_(INK)} }} @media (prefers-color-scheme: dark) {{ .brim {{ fill: {hex_(PAPER)} }} }}</style>
  <path fill="{hex_(AMBER)}" d="{' '.join(paths)}"/>
  <rect class="brim" x="{x0}" y="{y0}" width="{x1 - x0}" height="{y1 - y0}" rx="{BRIM_R}"/>
</svg>
'''


def mark(size, brim):
    """The mark as a transparent RGBA image of size x size."""
    k = size * SS / 512
    img = Image.new('RGBA', (size * SS, size * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.pieslice(((CX - R) * k, (CY - R) * k, (CX + R) * k, (CY + R) * k), 180, 360, fill=AMBER)
    for g in GAPS:
        d.rectangle(((g - GAP_W / 2) * k, (CY - R) * k, (g + GAP_W / 2) * k, CY * k), fill=(0, 0, 0, 0))
    d.rounded_rectangle([v * k for v in BRIM], BRIM_R * k, fill=brim)
    return img.resize((size, size), Image.LANCZOS)


def load(name, size):
    for d in FONT_DIRS:
        p = os.path.join(d, name)
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    raise SystemExit(f'font {name} not found')


# Banner, at 1280 x 640; drawn at 2x and scaled down.
W, H, BS = 1280, 640, 2
MARK_W = 270                        # width of the mark's ink (dome and brim) in the banner
WORD, WORD_SIZE, TRACK = 'foreman', 150, -0.02
TAGLINE, TAG_SIZE = 'One task. A crew of coding agents.', 40
MONO_PARTS, MONO_SIZE, MONO_SEP = ['herdr plugin', 'panes', 'git worktrees', 'you approve'], 24, '  /  '
GAP_X = 56                          # mark to wordmark
TAG_DY, MONO_DY = 66, 124           # tagline and mono baselines below the wordmark baseline


def tracked(d, x, y, text, font, fill, track):
    """Text with letter spacing; prefix widths keep the font's kerning."""
    for i, ch in enumerate(text):
        d.text((x + font.getlength(text[:i]) + i * track, y), ch, font=font, fill=fill, anchor='ls')
    return font.getlength(text) + (len(text) - 1) * track


def lockup_metrics(s):
    """Width of the mark + wordmark lockup at scale s, and its height above the baseline."""
    word = load('Barlow-SemiBold.ttf', round(WORD_SIZE * s))
    track = TRACK * WORD_SIZE * s
    k = MARK_W * s / (BRIM[2] - BRIM[0])
    width = (MARK_W + GAP_X) * s + word.getlength(WORD) + (len(WORD) - 1) * track
    top = max(-word.getbbox('f', anchor='ls')[1], (BRIM[3] - (CY - R)) * k)
    return width, top


def draw_lockup(img, x, base, s, fg):
    """Mark + wordmark at scale s (1 = banner size): mark ink starts at x and its
    brim bottom sits on the wordmark baseline. Returns the wordmark's x."""
    word = load('Barlow-SemiBold.ttf', round(WORD_SIZE * s))
    k = MARK_W * s / (BRIM[2] - BRIM[0])
    m = mark(round(512 * k), fg)
    img.paste(m, (round(x - BRIM[0] * k), round(base - BRIM[3] * k)), m)
    tx = x + (MARK_W + GAP_X) * s
    tracked(ImageDraw.Draw(img), tx, base, WORD, word, fg, TRACK * WORD_SIZE * s)
    return tx


def banner(theme):
    bg, fg, tag_c, mono_c, accent = THEMES[theme]
    s = BS
    tag = load('Barlow-Regular.ttf', TAG_SIZE * s)
    mono = load('CascadiaMono.ttf', MONO_SIZE * s)
    mono_text = MONO_SEP.join(MONO_PARTS)

    lock_w, top = lockup_metrics(s)
    text_w = max(lock_w - (MARK_W + GAP_X) * s, tag.getlength(TAGLINE), mono.getlength(mono_text))
    left = (W * s - ((MARK_W + GAP_X) * s + text_w)) / 2

    # Centre the block from the top of the mark or wordmark to the bottom of the mono line.
    bottom = MONO_DY * s + mono.getbbox('gp', anchor='ls')[3]
    base = (H * s - (top + bottom)) / 2 + top

    img = Image.new('RGB', (W * s, H * s), bg)
    tx = draw_lockup(img, left, base, s, fg)
    d = ImageDraw.Draw(img)
    d.text((tx, base + TAG_DY * s), TAGLINE, font=tag, fill=tag_c, anchor='ls')
    x = tx
    for i, part in enumerate(MONO_PARTS):
        if i:
            d.text((x, base + MONO_DY * s), MONO_SEP, font=mono, fill=mono_c, anchor='ls')
            x += mono.getlength(MONO_SEP)
        d.text((x, base + MONO_DY * s), part, font=mono, fill=accent if i == 0 else mono_c, anchor='ls')
        x += mono.getlength(part)
    return img.resize((W, H), Image.LANCZOS)


def contact_sheet(path):
    sizes, pad = (16, 32, 64), 16
    cell = sum(sizes) + pad * (len(sizes) + 1)
    sheet = Image.new('RGB', (cell * 2, 64 + 2 * pad), INK)
    sheet.paste(PAPER, (0, 0, cell, sheet.height))
    for col, brim in enumerate((INK, PAPER)):
        x = col * cell + pad
        for size in sizes:
            m = mark(size, brim)
            sheet.paste(m, (x, pad + 64 - size), m)
            x += size + pad
    sheet.save(path)
    print('contact sheet:', path)


def main():
    with open(os.path.join(MEDIA, 'logo.svg'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(svg())
    mark(512, PAPER).save(os.path.join(MEDIA, 'logo-512.png'))
    banner('dark').save(os.path.join(MEDIA, 'banner.png'))
    banner('light').save(os.path.join(MEDIA, 'banner-light.png'))
    if '--check' in sys.argv:
        i = sys.argv.index('--check')
        path = sys.argv[i + 1] if i + 1 < len(sys.argv) else os.path.join(tempfile.gettempdir(), 'foreman-brand-check.png')
        contact_sheet(path)


if __name__ == '__main__':
    main()
