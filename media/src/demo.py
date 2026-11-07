"""Render the 40-second foreman demo: frames drawn with Pillow, piped to ffmpeg.

    python media/src/music.py music.wav
    python media/src/demo.py music.wav demo.mp4        # video with music
    python media/src/demo.py --still 21 frame.png      # one frame, for checking

Needs Pillow, numpy, ffmpeg on PATH and the Cascadia Mono, Segoe UI and
Montserrat fonts (Windows). FOREMAN_REPO sets the GitHub repo shown at the end.
The run shown follows foreman's real flow and command names; the repository,
findings and commit ids are made up for the demo.
"""
import os
import shutil
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H, FPS, LENGTH = 1920, 1080, 30, 40.0
REPO = os.environ.get('FOREMAN_REPO', 'Kuba7331/herdr-foreman')
HERE = os.path.dirname(os.path.abspath(__file__))
FONT_DIRS = [os.path.join(os.environ.get('WINDIR', 'C:/Windows'), 'Fonts'),
             os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Microsoft', 'Windows', 'Fonts')]


def load(name, size, variation=None):
    for d in FONT_DIRS:
        p = os.path.join(d, name)
        if os.path.exists(p):
            f = ImageFont.truetype(p, size)
            if variation:
                f.set_variation_by_name(variation)
            return f
    raise SystemExit(f'font {name} not found')


MONO = load('CascadiaMono.ttf', 24)
MONO_B = load('CascadiaMono.ttf', 24, 'Bold')
MONO_BIG = load('CascadiaMono.ttf', 36)
CAPTION = load('seguisb.ttf', 44)
STEP = load('segoeuib.ttf', 21)
TITLE = load('Montserrat-VariableFont_wght.ttf', 140, 'ExtraBold')
TITLE_S = load('Montserrat-VariableFont_wght.ttf', 104, 'ExtraBold')
TAG = load('segoeui.ttf', 46)
SMALL = load('segoeui.ttf', 31)
WIN_TITLE = load('segoeui.ttf', 22)
CHAR_W = MONO.getlength('M')
LINE_H = 34

BG0, BG1 = (8, 12, 23), (19, 29, 51)
WIN, WIN_BORDER, TITLEBAR = (12, 18, 33), (40, 54, 84), (18, 27, 46)
PANE, PANE_BORDER, PANE_FOCUS = (14, 21, 38), (36, 50, 78), (96, 118, 160)
FG, DIM, WHITE = (214, 222, 235), (110, 125, 156), (246, 248, 251)
AMBER, GREEN, BLUE, RED, VIOLET = (251, 191, 36), (52, 211, 153), (56, 189, 248), (248, 113, 113), (192, 132, 252)
STATE_COLOR = {'starting': DIM, 'working': AMBER, 'done': GREEN, 'idle': BLUE}
STATE_LABEL = {'starting': 'starting', 'working': 'working', 'done': 'done', 'idle': 'waiting for you'}

X0, Y0, X1, Y1 = 100, 52, 1820, 880          # terminal window
TITLE_H = 46
TASK = 'fix-payment-security-holes'


def clamp(v, lo=0.0, hi=1.0):
    return max(lo, min(hi, v))


def ease(v):
    v = clamp(v)
    return 1 - (1 - v) ** 3


def mix(a, b, k):
    return tuple(int(a[i] + (b[i] - a[i]) * k) for i in range(3))


# ---------------------------------------------------------------- timeline

def L(t, *spans):
    return {'t': t, 'spans': list(spans)}


def TYPED(t, prefix, text, cps, color=WHITE):
    return {'t': t, 'spans': [prefix], 'type': text, 'cps': cps, 'color': color}


SHELL = [
    L(4.0, ('~/shop ', BLUE), ('main', VIOLET)),
    TYPED(4.2, ('> ', GREEN), 'foreman "fix payment security holes"', 15),
    L(7.5, (f'Leader "lead" (claude) started in pane w1:p1 for task "{TASK}".', DIM)),
]

LEAD = [
    L(8.7, ('$ ', DIM), ('foreman brief --json', FG)),
    L(9.3, ('agents   ', DIM), ('claude ✓', GREEN), ('  codex ✓', GREEN), ('  opencode ✓', GREEN), ('  gemini – not signed in', DIM)),
    L(9.9, ('', FG)),
    L(10.0, ('plan', AMBER), ('   part   category        agent         effort', DIM)),
    L(10.3, ('       sec1   ', BLUE), ('security-audit  ', FG), ('claude:opus   ', VIOLET), ('high', FG)),
    L(10.6, ('       test1  ', BLUE), ('testing         ', FG), ('codex         ', VIOLET), ('medium', FG)),
    L(10.9, ('       deps1  ', BLUE), ('security-audit  ', FG), ('opencode      ', VIOLET), ('low', FG)),
    TYPED(11.5, ('$ ', DIM), f'foreman spawn --task {TASK} …', 34, FG),
    L(13.3, ('3 workers · 3 git worktrees · 3 panes', GREEN)),
    L(14.8, ('$ ', DIM), ('herdr agent prompt ×3', FG), ('   investigate only, change nothing', DIM)),
    L(15.3, ('$ ', DIM), (f'foreman wait --task {TASK}', FG)),
    L(19.5, ('done  ', GREEN), ('sec1 test1 deps1', FG)),
    L(19.8, ('', FG)),
    L(19.9, ('proposals', AMBER)),
    L(20.2, ('1 ', WHITE), ('[high] ', RED), ('charge.ts: amount trusted from client  ', FG), ('sec1', DIM)),
    L(20.5, ('2 ', WHITE), ('[high] ', RED), ('webhook.ts: signature never checked    ', FG), ('sec1', DIM)),
    L(20.8, ('3 ', WHITE), ('[med]  ', AMBER), ('refund paths have no tests             ', FG), ('test1', DIM)),
    L(21.1, ('4 ', WHITE), ('[low]  ', BLUE), ('payment-sdk 2.1: advisory -> 2.4       ', FG), ('deps1', DIM)),
    L(21.6, ('Which items should I do?', WHITE)),
    TYPED(22.0, ('› ', AMBER), '1, 2 and 3 yes, 4 no', 15),
    L(24.2, ('$ ', DIM), (f'foreman wait --task {TASK} --phase implement', FG)),
    L(28.4, ('$ ', DIM), (f'foreman merge --task {TASK}', FG)),
    L(28.9, ('merged ', GREEN), ('sec1 test1', FG), (f' → foreman/{TASK}', DIM)),
    L(29.4, ('$ ', DIM), ('npm test', FG)),
    L(29.9, ('46 passed', GREEN), (', 0 failed', DIM)),
    L(30.4, ('', FG)),
    L(30.5, ('3 changes in 4 files, tests pass. What now?', WHITE)),
    L(30.9, ('1 ', AMBER), ('merge into main    ', FG), ('2 ', AMBER), ('leave the branch    ', FG), ('3 ', AMBER), ('comments', FG)),
    TYPED(31.6, ('› ', AMBER), '1', 6),
    L(32.4, ('$ ', DIM), (f'foreman land --task {TASK}', FG)),
    L(32.9, ('main updated · nothing pushed, no pull request', GREEN)),
    L(33.6, ('$ ', DIM), (f'foreman cleanup --task {TASK}', FG)),
    L(34.2, ('3 panes closed · worktrees removed · journal updated', GREEN)),
]
LEAD_STATES = [(8.5, 'working'), (21.7, 'idle'), (23.6, 'working'), (31.0, 'idle'), (31.9, 'working'), (34.4, 'idle')]

WORKERS = [
    {'name': 'sec1', 'agent': 'claude:opus',
     'states': [(13.9, 'starting'), (14.9, 'working'), (19.1, 'done'), (24.5, 'working'), (28.1, 'done')],
     'lines': [L(14.6, ('branch foreman-work/…/sec1', DIM)),
               L(15.4, ('investigate src/payments/', FG)),
               L(16.2, ('read charge.ts, webhook.ts', FG)),
               L(17.2, ('! ', AMBER), ('amount comes from the request body', FG)),
               L(18.1, ('! ', AMBER), ('webhook signature is never checked', FG)),
               L(18.9, ('wrote .foreman/proposals.md', GREEN)),
               L(24.6, ('implement 1, 2', FG)),
               L(25.5, ('edit charge.ts, webhook.ts', FG)),
               L(26.5, ('npm test → 42 passed', GREEN)),
               L(27.2, ('commit 3f2a1c9 compute amount on server', DIM)),
               L(27.8, ('commit 8be41d0 verify webhook signature', DIM))]},
    {'name': 'test1', 'agent': 'codex',
     'states': [(13.9, 'starting'), (15.0, 'working'), (18.7, 'done'), (24.6, 'working'), (27.9, 'done')],
     'lines': [L(14.7, ('branch foreman-work/…/test1', DIM)),
               L(15.6, ('investigate test/payments/', FG)),
               L(16.4, ('npm test → 42 passed', GREEN)),
               L(17.4, ('! ', AMBER), ('refund.ts has no tests', FG)),
               L(18.5, ('wrote .foreman/proposals.md', GREEN)),
               L(24.8, ('implement 3', FG)),
               L(25.8, ('add test/refund.test.js, 4 tests', FG)),
               L(26.9, ('npm test → 46 passed', GREEN)),
               L(27.6, ('commit c71e9a2 add refund tests', DIM))]},
    {'name': 'deps1', 'agent': 'opencode',
     'states': [(13.9, 'starting'), (15.1, 'working'), (18.3, 'done')],
     'lines': [L(14.8, ('branch foreman-work/…/deps1', DIM)),
               L(15.8, ('investigate package.json, lockfile', FG)),
               L(16.6, ('npm audit', FG)),
               L(17.5, ('! ', AMBER), ('payment-sdk 2.1.0: 1 advisory', FG)),
               L(18.1, ('wrote .foreman/proposals.md', GREEN)),
               L(24.5, ('no approved items', DIM))]},
]

CAPTIONS = [
    (4.2, 8.3, '01   DESCRIBE', 'Describe the task in plain words.'),
    (8.6, 13.7, '02   PLAN', 'The leader checks which agents you have and picks one per part.'),
    (14.0, 19.8, '03   INVESTIGATE', 'Every worker gets its own pane and git worktree. Nothing changes yet.'),
    (20.0, 24.0, '04   APPROVE', 'You approve one numbered list.'),
    (24.2, 30.3, '05   IMPLEMENT', 'Approved work is committed, merged on a local branch and tested.'),
    (30.5, 35.2, '06   YOU DECIDE', 'Nothing is pushed. No pull request. Your call.'),
]


def state_at(states, t):
    current = None
    for when, s in states:
        if t >= when:
            current = s
    return current


def split_at(t):
    """0 = leader fills the window, 1 = leader left, workers right."""
    if t < 13.8:
        return 0.0
    if t < 34.6:
        return ease((t - 13.8) / 0.7)
    return 1 - ease((t - 34.6) / 0.6)


# ---------------------------------------------------------------- drawing

def background():
    y = np.linspace(0, 1, H)[:, None, None]
    x = np.linspace(0, 1, W)[None, :, None]
    base = np.array(BG1) * (1 - y) + np.array(BG0) * y
    glow = np.exp(-(((x - 0.5) * 1.6) ** 2 + ((y - 0.42) * 2.2) ** 2) * 3) * np.array([60, 42, 8]) * 0.35
    return Image.fromarray(np.clip(base + glow, 0, 255).astype('uint8'))


def with_shadow(img):
    img = img.copy()
    shadow = Image.new('L', (W, H), 0)
    ImageDraw.Draw(shadow).rounded_rectangle((X0 + 10, Y0 + 24, X1 - 10, Y1 + 26), 26, fill=150)
    img.paste((0, 0, 0), mask=shadow.filter(ImageFilter.GaussianBlur(28)))
    return img


PLAIN = background()
BACKGROUND = with_shadow(PLAIN)
LOGO = Image.open(os.path.join(HERE, '..', 'logo-512.png')).convert('RGBA')


def spans_at(line, t, bg):
    """Spans of a line at time t, faded in from bg, plus whether to draw a cursor."""
    k = clamp((t - line['t']) / 0.18)
    spans = [(text, mix(bg, color, k)) for text, color in line['spans']]
    cursor = False
    if 'type' in line:
        start = line['t'] + 0.25
        n = int(clamp((t - start) * line['cps'], 0, len(line['type'])))
        spans.append((line['type'][:n], mix(bg, line['color'], k)))
        done_at = start + len(line['type']) / line['cps']
        cursor = t < done_at + 0.4
    return spans, cursor


def draw_spans(d, x, y, spans, font=MONO, cursor=False):
    for text, color in spans:
        d.text((x, y), text, font=font, fill=color)
        x += font.getlength(text)
    if cursor:
        d.rectangle((x + 2, y + 3, x + CHAR_W - 1, y + LINE_H - 7), fill=FG)


def text_block(w, h, lines, t, bg=PANE):
    """Render the visible lines into a w x h image, scrolled to the bottom."""
    img = Image.new('RGB', (w, h), bg)
    d = ImageDraw.Draw(img)
    shown = [ln for ln in lines if t >= ln['t']]
    rows = max(1, h // LINE_H)
    for i, ln in enumerate(shown[-rows:]):
        spans, cursor = spans_at(ln, t, bg)
        draw_spans(d, 0, i * LINE_H, spans, cursor=cursor)
    return img


def draw_pane(img, box, title, state, lines, t, focus=False, alpha=1.0):
    x0, y0, x1, y1 = (int(v) for v in box)
    w, h = x1 - x0, y1 - y0
    if w < 40 or alpha <= 0:
        return
    # drawn on its own image so a pane that is opening or closing clips its text
    pane = Image.new('RGB', (w, h), WIN)
    d = ImageDraw.Draw(pane)
    border = mix(WIN, PANE_FOCUS if focus else PANE_BORDER, alpha)
    d.rounded_rectangle((0, 0, w - 1, h - 1), 12, fill=mix(WIN, PANE, alpha), outline=border, width=2)
    hx = 18
    for text, color in title:
        d.text((hx, 9), text, font=MONO_B if color == WHITE else MONO, fill=mix(PANE, color, alpha))
        hx += MONO.getlength(text)
    if state:
        label, color = STATE_LABEL[state], STATE_COLOR[state]
        lw = MONO.getlength(label)
        d.text((w - 18 - lw, 9), label, font=MONO, fill=mix(PANE, color, alpha))
        cx, cy = w - 34 - lw, 23
        d.ellipse((cx - 7, cy - 7, cx + 7, cy + 7), fill=mix(PANE, color, alpha))
    d.line((2, 46, w - 3, 46), fill=mix(PANE, PANE_BORDER, alpha), width=1)
    inner = text_block(max(1, w - 36), max(1, h - 66), lines, t)
    if alpha < 1:
        inner = Image.blend(Image.new('RGB', inner.size, PANE), inner, alpha)
    pane.paste(inner, (18, 58))
    img.paste(pane, (x0, y0))


def draw_window(img, title):
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((X0, Y0, X1, Y1), 18, fill=WIN, outline=WIN_BORDER, width=2)
    d.rounded_rectangle((X0 + 2, Y0 + 2, X1 - 2, Y0 + TITLE_H), 16, fill=TITLEBAR)
    d.rectangle((X0 + 2, Y0 + 24, X1 - 2, Y0 + TITLE_H), fill=TITLEBAR)
    d.line((X0 + 2, Y0 + TITLE_H, X1 - 2, Y0 + TITLE_H), fill=WIN_BORDER, width=2)
    for i in range(3):
        cx = X0 + 26 + i * 24
        d.ellipse((cx - 7, Y0 + 16, cx + 7, Y0 + 30), fill=(62, 74, 98))
    tw = WIN_TITLE.getlength(title)
    d.text(((X0 + X1 - tw) / 2, Y0 + 10), title, font=WIN_TITLE, fill=DIM)


def draw_caption(img, t):
    d = ImageDraw.Draw(img)
    for t0, t1, step, text in CAPTIONS:
        if t0 <= t <= t1:
            k = min(ease((t - t0) / 0.35), ease((t1 - t) / 0.3))
            bg = BG0
            x = (W - sum(STEP.getlength(c) + 3 for c in step)) / 2
            for c in step:
                d.text((x, 906), c, font=STEP, fill=mix(bg, AMBER, k))
                x += STEP.getlength(c) + 3
            tw = CAPTION.getlength(text)
            d.text(((W - tw) / 2, 940 + (1 - k) * 10), text, font=CAPTION, fill=mix(bg, WHITE, k))


def scene_main(t):
    img = BACKGROUND.copy()
    if t < 8.4:
        draw_window(img, 'pwsh · ~/shop')
        block = text_block(X1 - X0 - 64, Y1 - Y0 - TITLE_H - 40, SHELL, t, bg=WIN)
        img.paste(block, (X0 + 32, Y0 + TITLE_H + 24))
    else:
        draw_window(img, 'herdr · foreman')
        s = split_at(t)
        cx0, cy0, cx1, cy1 = X0 + 14, Y0 + TITLE_H + 14, X1 - 14, Y1 - 14
        full = cx1 - cx0
        lead_x1 = cx1 - (full * 0.42) * s
        draw_pane(img, (cx0, cy0, lead_x1 - 7 * s, cy1), [('lead', WHITE), (' · claude:opus', DIM)],
                  state_at(LEAD_STATES, t), LEAD, t, focus=True)
        if s > 0:
            gap = 14
            ph = (cy1 - cy0 - 2 * gap) / 3
            for i, w in enumerate(WORKERS):
                top = cy0 + i * (ph + gap)
                draw_pane(img, (lead_x1 + 7 * s, top, cx1, top + ph), [(w['name'], WHITE), (f" · {w['agent']}", DIM)],
                          state_at(w['states'], t), w['lines'], t, alpha=s)
    draw_caption(img, t)
    return img


def paste_logo(img, size, cx, cy, alpha):
    logo = LOGO.resize((int(size), int(size)), Image.LANCZOS)
    if alpha < 1:
        logo.putalpha(logo.getchannel('A').point(lambda v: int(v * alpha)))
    img.paste(logo, (int(cx - size / 2), int(cy - size / 2)), logo)


def centered(d, y, text, font, color):
    d.text(((W - font.getlength(text)) / 2, y), text, font=font, fill=color)


def scene_intro(t):
    img = PLAIN.copy()
    d = ImageDraw.Draw(img)
    a = ease(t / 0.9)
    paste_logo(img, 300 * (0.85 + 0.15 * a), W / 2, 370, a)
    k = ease((t - 0.5) / 0.7)
    centered(d, 560 + (1 - k) * 24, 'foreman', TITLE, mix(BG0, WHITE, k))
    k = ease((t - 1.1) / 0.7)
    centered(d, 750, 'One task. A crew of coding agents.', TAG, mix(BG0, (203, 213, 225), k))
    k = ease((t - 1.6) / 0.7)
    centered(d, 830, 'a herdr plugin', SMALL, mix(BG0, AMBER, k))
    return img


def scene_outro(t):
    t -= 35.4
    img = PLAIN.copy()
    d = ImageDraw.Draw(img)
    a = ease(t / 0.8)
    paste_logo(img, 210 * (0.88 + 0.12 * a), W / 2, 250, a)
    k = ease((t - 0.3) / 0.6)
    centered(d, 380, 'foreman', TITLE_S, mix(BG0, WHITE, k))
    k = ease((t - 0.6) / 0.6)
    centered(d, 525, 'One task. A crew of coding agents.', TAG, mix(BG0, (203, 213, 225), k))
    k = ease((t - 1.0) / 0.6)
    cmd = f'herdr plugin install {REPO}'
    cw = MONO_BIG.getlength('$ ' + cmd)
    bx0, bx1 = (W - cw) / 2 - 36, (W + cw) / 2 + 36
    d.rounded_rectangle((bx0, 640, bx1, 720), 14, fill=mix(BG0, (16, 24, 42), k), outline=mix(BG0, WIN_BORDER, k), width=2)
    d.text((bx0 + 36, 658), '$ ', font=MONO_BIG, fill=mix(BG0, AMBER, k))
    d.text((bx0 + 36 + MONO_BIG.getlength('$ '), 658), cmd, font=MONO_BIG, fill=mix(BG0, WHITE, k))
    k = ease((t - 1.4) / 0.6)
    centered(d, 760, 'Then one key in herdr, or  foreman "<task>"  in any git repo.', SMALL, mix(BG0, DIM, k))
    k = ease((t - 1.8) / 0.6)
    centered(d, 840, f'github.com/{REPO}', SMALL, mix(BG0, AMBER, k))
    return img


def frame(t):
    if t < 3.4:
        return scene_intro(t)
    if t < 4.0:
        return Image.blend(scene_intro(t), scene_main(t), ease((t - 3.4) / 0.6))
    if t < 35.4:
        return scene_main(t)
    if t < 36.0:
        return Image.blend(scene_main(t), scene_outro(t), ease((t - 35.4) / 0.6))
    img = scene_outro(t)
    if t > LENGTH - 0.8:
        img = Image.blend(img, Image.new('RGB', img.size, (0, 0, 0)), clamp((t - (LENGTH - 0.8)) / 0.8))
    return img


def main(argv):
    if argv[:1] == ['--still']:
        frame(float(argv[1])).save(argv[2])
        return
    music, out = argv[0], argv[1]
    ffmpeg = shutil.which('ffmpeg') or sys.exit('ffmpeg not found on PATH')
    proc = subprocess.Popen([
        ffmpeg, '-y', '-loglevel', 'error',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
        '-i', music,
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-tune', 'animation',
        '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out,
    ], stdin=subprocess.PIPE)
    total = int(LENGTH * FPS)
    for i in range(total):
        proc.stdin.write(frame(i / FPS).tobytes())
        if i % (FPS * 5) == 0:
            print(f'{i / FPS:4.0f} s', flush=True)
    proc.stdin.close()
    sys.exit(proc.wait())


if __name__ == '__main__':
    main(sys.argv[1:])
