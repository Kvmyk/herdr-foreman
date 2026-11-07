"""Render the foreman demo: frames drawn with Pillow, piped to ffmpeg.

    python media/src/music.py music.wav
    python media/src/demo.py music.wav demo.mp4               # 16:9, README
    python media/src/demo.py music.wav demo-li.mp4 --linkedin  # 4:5, LinkedIn
    python media/src/demo.py --still 21 frame.png              # one 16:9 frame
    python media/src/demo.py --still 21 frame.png --linkedin   # one 4:5 frame

Needs Pillow, numpy, ffmpeg on PATH and the Cascadia Mono and Segoe UI
fonts (Windows). Barlow (SIL OFL) is vendored in media/src/fonts.
FOREMAN_REPO sets the GitHub repo shown at the end.
The run shown follows foreman's real flow and command names; the repository,
findings and commit ids are made up.
"""
import os
import shutil
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

REPO = os.environ.get('FOREMAN_REPO', 'Kvmyk/herdr-foreman')
HERE = os.path.dirname(os.path.abspath(__file__))
FONT_DIRS = [os.path.join(HERE, 'fonts'),
             os.path.join(os.environ.get('WINDIR', 'C:/Windows'), 'Fonts'),
             os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Microsoft', 'Windows', 'Fonts')]

# Brand palette (from brand.py)
INK = (17, 17, 19)         # #111113
PAPER = (244, 241, 234)    # #F4F1EA
AMBER = (255, 176, 0)      # #FFB000


def load(name, size, variation=None):
    for d in FONT_DIRS:
        p = os.path.join(d, name)
        if os.path.exists(p):
            f = ImageFont.truetype(p, size)
            if variation:
                f.set_variation_by_name(variation)
            return f
    raise SystemExit(f'font {name} not found')


# ---------------------------------------------------------------- profiles
# Each profile defines canvas size, terminal geometry and caption placement.

def _profile_16x9():
    W, H, FPS = 1920, 1080, 30
    X0, Y0, X1, Y1 = 100, 40, 1820, 870
    TITLE_H = 46
    return dict(W=W, H=H, FPS=FPS, X0=X0, Y0=Y0, X1=X1, Y1=Y1, TITLE_H=TITLE_H,
                CAP_Y=Y1 + 30, CAP_FONT_SIZE=36, CAP_SAFE_BOTTOM=H)


def _profile_linkedin():
    W, H, FPS = 1080, 1350, 30
    X0, Y0, X1, Y1 = 30, 40, 1050, 1060
    TITLE_H = 46
    # Captions inside the safe zone: top 150 px, bottom 250 px reserved by LI UI
    return dict(W=W, H=H, FPS=FPS, X0=X0, Y0=Y0, X1=X1, Y1=Y1, TITLE_H=TITLE_H,
                CAP_Y=Y1 + 30, CAP_FONT_SIZE=36, CAP_SAFE_BOTTOM=H - 250)


# ---------------------------------------------------------------- timeline

# LinkedIn compresses some pauses; these offsets are applied additively
# to timestamps >= the key. Built by _remap_linkedin().
_LI_CUTS = [
    # (original_t, new_t) — piecewise-linear remap
    (0.0,   0.0),
    (4.0,   4.0),     # shell typing unchanged
    (7.5,   6.5),     # leader start: slightly compressed
    (13.8,  11.0),    # split opens
    (19.5,  16.0),    # investigate done — compress the wait
    (24.0,  20.0),    # approve section
    (28.4,  23.5),    # implement done
    (30.5,  25.0),    # "you decide" section
    (32.4,  26.5),    # merge
    (34.4,  27.5),    # cleanup done
    (35.4,  28.0),    # outro starts
    (37.4,  30.0),    # outro ends (2 s)
]


def _remap_li(t):
    """Remap a 16:9 timestamp to LinkedIn time."""
    for i in range(len(_LI_CUTS) - 1):
        t0, n0 = _LI_CUTS[i]
        t1, n1 = _LI_CUTS[i + 1]
        if t <= t1:
            return n0 + (n1 - n0) * (t - t0) / (t1 - t0)
    # Past the last cut point
    t0, n0 = _LI_CUTS[-1]
    return n0 + (t - t0)


def _remap_li_inv(nt):
    """Inverse: given LinkedIn time, return original time."""
    for i in range(len(_LI_CUTS) - 1):
        t0, n0 = _LI_CUTS[i]
        t1, n1 = _LI_CUTS[i + 1]
        if nt <= n1:
            if n1 == n0:
                return t0
            return t0 + (t1 - t0) * (nt - n0) / (n1 - n0)
    t0, n0 = _LI_CUTS[-1]
    return t0 + (nt - n0)


# Total lengths
LENGTH_16x9 = 37.4     # no intro, short outro: terminal scene + 2 s outro
LENGTH_LI = 30.0


def L(t, *spans):
    return {'t': t, 'spans': list(spans)}


def TYPED(t, prefix, text, cps, color=None):
    if color is None:
        color = PAPER
    return {'t': t, 'spans': [prefix], 'type': text, 'cps': cps, 'color': color}


TASK = 'fix-payment-security-holes'

SHELL = [
    L(0.0, ('~/shop ', (56, 189, 248)), ('main', (192, 132, 252))),
    TYPED(0.2, ('> ', (52, 211, 153)), 'foreman "fix payment security holes"', 15),
    L(3.5, (f'Leader "lead" (claude) started in pane w1:p1 for task "{TASK}".', (110, 125, 156))),
]

DIM = (110, 125, 156)
FG = (214, 222, 235)
GREEN = (52, 211, 153)
BLUE = (56, 189, 248)
VIOLET = (192, 132, 252)
RED = (248, 113, 113)

LEAD = [
    L(4.7, ('$ ', DIM), ('foreman brief --json', FG)),
    L(5.3, ('agents   ', DIM), ('claude ✓', GREEN), ('  codex ✓', GREEN), ('  opencode ✓', GREEN), ('  gemini – not signed in', DIM)),
    L(5.9, ('', FG)),
    L(6.0, ('plan', AMBER), ('   part   category        agent         effort', DIM)),
    L(6.3, ('       sec1   ', BLUE), ('security-audit  ', FG), ('claude:opus   ', VIOLET), ('high', FG)),
    L(6.6, ('       test1  ', BLUE), ('testing         ', FG), ('codex         ', VIOLET), ('medium', FG)),
    L(6.9, ('       deps1  ', BLUE), ('security-audit  ', FG), ('opencode      ', VIOLET), ('low', FG)),
    TYPED(7.5, ('$ ', DIM), f'foreman spawn --task {TASK} …', 34, FG),
    L(9.3, ('3 workers · 3 git worktrees · 3 panes', GREEN)),
    L(10.8, ('$ ', DIM), ('herdr agent prompt ×3', FG), ('   investigate only, change nothing', DIM)),
    L(11.3, ('$ ', DIM), (f'foreman wait --task {TASK}', FG)),
    L(15.5, ('done  ', GREEN), ('sec1 test1 deps1', FG)),
    L(15.8, ('', FG)),
    L(15.9, ('proposals', AMBER)),
    L(16.2, ('1 ', PAPER), ('[high] ', RED), ('charge.ts: amount trusted from client  ', FG), ('sec1', DIM)),
    L(16.5, ('2 ', PAPER), ('[high] ', RED), ('webhook.ts: signature never checked    ', FG), ('sec1', DIM)),
    L(16.8, ('3 ', PAPER), ('[med]  ', AMBER), ('refund paths have no tests             ', FG), ('test1', DIM)),
    L(17.1, ('4 ', PAPER), ('[low]  ', BLUE), ('payment-sdk 2.1: advisory -> 2.4       ', FG), ('deps1', DIM)),
    L(17.6, ('Which items should I do?', PAPER)),
    TYPED(18.0, ('› ', AMBER), '1, 2 and 3 yes, 4 no', 15),
    L(20.2, ('$ ', DIM), (f'foreman wait --task {TASK} --phase implement', FG)),
    L(24.4, ('$ ', DIM), (f'foreman merge --task {TASK}', FG)),
    L(24.9, ('merged ', GREEN), ('sec1 test1', FG), (f' → foreman/{TASK}', DIM)),
    L(25.4, ('$ ', DIM), ('npm test', FG)),
    L(25.9, ('46 passed', GREEN), (', 0 failed', DIM)),
    L(26.4, ('', FG)),
    L(26.5, ('3 changes in 4 files, tests pass. What now?', PAPER)),
    L(26.9, ('1 ', AMBER), ('merge into main    ', FG), ('2 ', AMBER), ('leave the branch    ', FG), ('3 ', AMBER), ('comments', FG)),
    TYPED(27.6, ('› ', AMBER), '1', 6),
    L(28.4, ('$ ', DIM), (f'foreman land --task {TASK}', FG)),
    L(28.9, ('main updated · nothing pushed, no pull request', GREEN)),
    L(29.6, ('$ ', DIM), (f'foreman cleanup --task {TASK}', FG)),
    L(30.2, ('3 panes closed · worktrees removed · journal updated', GREEN)),
]
LEAD_STATES = [(4.5, 'working'), (17.7, 'idle'), (19.6, 'working'), (27.0, 'idle'), (27.9, 'working'), (30.4, 'idle')]

WORKERS = [
    {'name': 'sec1', 'agent': 'claude:opus',
     'states': [(9.9, 'starting'), (10.9, 'working'), (15.1, 'done'), (20.5, 'working'), (24.1, 'done')],
     'lines': [L(10.6, ('branch foreman-work/…/sec1', DIM)),
               L(11.4, ('investigate src/payments/', FG)),
               L(12.2, ('read charge.ts, webhook.ts', FG)),
               L(13.2, ('! ', AMBER), ('amount comes from the request body', FG)),
               L(14.1, ('! ', AMBER), ('webhook signature is never checked', FG)),
               L(14.9, ('wrote .foreman/proposals.md', GREEN)),
               L(20.6, ('implement 1, 2', FG)),
               L(21.5, ('edit charge.ts, webhook.ts', FG)),
               L(22.5, ('npm test → 42 passed', GREEN)),
               L(23.2, ('commit 3f2a1c9 compute amount on server', DIM)),
               L(23.8, ('commit 8be41d0 verify webhook signature', DIM))]},
    {'name': 'test1', 'agent': 'codex',
     'states': [(9.9, 'starting'), (11.0, 'working'), (14.7, 'done'), (20.6, 'working'), (23.9, 'done')],
     'lines': [L(10.7, ('branch foreman-work/…/test1', DIM)),
               L(11.6, ('investigate test/payments/', FG)),
               L(12.4, ('npm test → 42 passed', GREEN)),
               L(13.4, ('! ', AMBER), ('refund.ts has no tests', FG)),
               L(14.5, ('wrote .foreman/proposals.md', GREEN)),
               L(20.8, ('implement 3', FG)),
               L(21.8, ('add test/refund.test.js, 4 tests', FG)),
               L(22.9, ('npm test → 46 passed', GREEN)),
               L(23.6, ('commit c71e9a2 add refund tests', DIM))]},
    {'name': 'deps1', 'agent': 'opencode',
     'states': [(9.9, 'starting'), (11.1, 'working'), (14.3, 'done')],
     'lines': [L(10.8, ('branch foreman-work/…/deps1', DIM)),
               L(11.8, ('investigate package.json, lockfile', FG)),
               L(12.6, ('npm audit', FG)),
               L(13.5, ('! ', AMBER), ('payment-sdk 2.1.0: 1 advisory', FG)),
               L(14.1, ('wrote .foreman/proposals.md', GREEN)),
               L(20.5, ('no approved items', DIM))]},
]

CAPTIONS_16x9 = [
    (0.2,   4.3,  'Describe the task in plain words.'),
    (4.6,   9.7,  'The leader checks agents and splits the work.'),
    (10.0,  15.8, 'Each worker investigates in its own worktree. Nothing changes yet.'),
    (16.0,  20.0, 'You approve what gets done.'),
    (20.2,  26.3, 'Workers implement, commit and test.'),
    (26.5,  31.2, 'Nothing is pushed. Your call.'),
]

CAPTIONS_LI = [
    (0.2,   3.8,  'One command. The task is described in plain words.'),
    (4.0,   8.5,  'The leader checks which agents you have and splits the work.'),
    (9.0,   14.0, 'Workers investigate in parallel. Nothing changes yet.'),
    (14.5,  18.5, 'You approve a numbered list of proposals.'),
    (19.0,  24.0, 'Workers implement, commit and test in separate worktrees.'),
    (24.5,  27.5, 'Nothing is pushed. No pull request. Your call.'),
]

STATE_COLOR = {'starting': DIM, 'working': AMBER, 'done': GREEN, 'idle': BLUE}
STATE_LABEL = {'starting': 'starting', 'working': 'working', 'done': 'done', 'idle': 'waiting for you'}


# ---------------------------------------------------------------- font loading

class Fonts:
    """Lazily loaded fonts for a given profile."""
    def __init__(self, profile):
        self.profile = profile
        self._cache = {}

    def _get(self, key, name, size, variation=None):
        if key not in self._cache:
            self._cache[key] = load(name, size, variation)
        return self._cache[key]

    @property
    def MONO(self):        return self._get('MONO', 'CascadiaMono.ttf', 24)
    @property
    def MONO_B(self):      return self._get('MONO_B', 'CascadiaMono.ttf', 24, 'Bold')
    @property
    def MONO_BIG(self):    return self._get('MONO_BIG', 'CascadiaMono.ttf', 36)
    @property
    def CAPTION(self):     return self._get('CAPTION', 'Barlow-SemiBold.ttf', self.profile['CAP_FONT_SIZE'])
    @property
    def STEP(self):        return self._get('STEP', 'Barlow-SemiBold.ttf', 21)
    @property
    def TITLE(self):       return self._get('TITLE', 'Barlow-SemiBold.ttf', 104)
    @property
    def TAG(self):         return self._get('TAG', 'Barlow-Regular.ttf', 40)
    @property
    def SMALL(self):       return self._get('SMALL', 'Barlow-Regular.ttf', 28)
    @property
    def WIN_TITLE(self):   return self._get('WIN_TITLE', 'Barlow-Regular.ttf', 22)


# ---------------------------------------------------------------- geometry helpers

def clamp(v, lo=0.0, hi=1.0):
    return max(lo, min(hi, v))


def ease(v):
    v = clamp(v)
    return 1 - (1 - v) ** 3


def mix(a, b, k):
    return tuple(int(a[i] + (b[i] - a[i]) * k) for i in range(3))


LINE_H = 34


def state_at(states, t):
    current = None
    for when, s in states:
        if t >= when:
            current = s
    return current


def split_at(t):
    """0 = leader fills the window, 1 = leader left, workers right."""
    if t < 9.8:
        return 0.0
    if t < 30.6:
        return ease((t - 9.8) / 0.7)
    return 1 - ease((t - 30.6) / 0.6)


# ---------------------------------------------------------------- drawing helpers

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


def draw_spans(d, x, y, spans, font, cursor=False, char_w=None):
    for text, color in spans:
        d.text((x, y), text, font=font, fill=color)
        x += font.getlength(text)
    if cursor and char_w:
        d.rectangle((x + 2, y + 3, x + char_w - 1, y + LINE_H - 7), fill=FG)


def text_block(w, h, lines, t, bg, font, char_w):
    """Render the visible lines into a w x h image, scrolled to the bottom."""
    img = Image.new('RGB', (w, h), bg)
    d = ImageDraw.Draw(img)
    shown = [ln for ln in lines if t >= ln['t']]
    rows = max(1, h // LINE_H)
    for i, ln in enumerate(shown[-rows:]):
        spans, cursor = spans_at(ln, t, bg)
        draw_spans(d, 0, i * LINE_H, spans, font, cursor=cursor, char_w=char_w)
    return img


# ---------------------------------------------------------------- pane colours (from old palette, but darker)
WIN = (14, 14, 18)
WIN_BORDER = (40, 40, 50)
TITLEBAR = (20, 20, 26)
PANE = (18, 18, 24)
PANE_BORDER = (40, 40, 50)
PANE_FOCUS = (96, 96, 120)


def draw_pane(img, box, title, state, lines, t, fonts, focus=False, alpha=1.0):
    x0, y0, x1, y1 = (int(v) for v in box)
    w, h = x1 - x0, y1 - y0
    if w < 40 or alpha <= 0:
        return
    pane = Image.new('RGB', (w, h), WIN)
    d = ImageDraw.Draw(pane)
    border = mix(WIN, PANE_FOCUS if focus else PANE_BORDER, alpha)
    d.rounded_rectangle((0, 0, w - 1, h - 1), 12, fill=mix(WIN, PANE, alpha), outline=border, width=2)
    hx = 18
    for text, color in title:
        d.text((hx, 9), text, font=fonts.MONO_B if color == PAPER else fonts.MONO, fill=mix(PANE, color, alpha))
        hx += fonts.MONO.getlength(text)
    if state:
        label, color = STATE_LABEL[state], STATE_COLOR[state]
        lw = fonts.MONO.getlength(label)
        d.text((w - 18 - lw, 9), label, font=fonts.MONO, fill=mix(PANE, color, alpha))
        cx, cy = w - 34 - lw, 23
        d.ellipse((cx - 7, cy - 7, cx + 7, cy + 7), fill=mix(PANE, color, alpha))
    d.line((2, 46, w - 3, 46), fill=mix(PANE, PANE_BORDER, alpha), width=1)
    char_w = fonts.MONO.getlength('M')
    inner = text_block(max(1, w - 36), max(1, h - 66), lines, t, PANE, fonts.MONO, char_w)
    if alpha < 1:
        inner = Image.blend(Image.new('RGB', inner.size, PANE), inner, alpha)
    pane.paste(inner, (18, 58))
    img.paste(pane, (x0, y0))


def draw_window(img, title, prof, fonts):
    X0, Y0, X1, Y1, TITLE_H = prof['X0'], prof['Y0'], prof['X1'], prof['Y1'], prof['TITLE_H']
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((X0, Y0, X1, Y1), 18, fill=WIN, outline=WIN_BORDER, width=2)
    d.rounded_rectangle((X0 + 2, Y0 + 2, X1 - 2, Y0 + TITLE_H), 16, fill=TITLEBAR)
    d.rectangle((X0 + 2, Y0 + 24, X1 - 2, Y0 + TITLE_H), fill=TITLEBAR)
    d.line((X0 + 2, Y0 + TITLE_H, X1 - 2, Y0 + TITLE_H), fill=WIN_BORDER, width=2)
    tw = fonts.WIN_TITLE.getlength(title)
    d.text(((X0 + X1 - tw) / 2, Y0 + 10), title, font=fonts.WIN_TITLE, fill=DIM)


def draw_caption(img, t, prof, fonts, captions, is_linkedin=False):
    d = ImageDraw.Draw(img)
    W = prof['W']
    cap_y = prof['CAP_Y']
    safe_bottom = prof['CAP_SAFE_BOTTOM']
    for t0, t1, text in captions:
        if t0 <= t <= t1:
            k = min(ease((t - t0) / 0.3), ease((t1 - t) / 0.25))
            tw = fonts.CAPTION.getlength(text)
            y = min(cap_y, safe_bottom - 50)
            d.text(((W - tw) / 2, y + (1 - k) * 8), text, font=fonts.CAPTION, fill=mix(INK, PAPER, k))


LOGO = None


def get_logo():
    global LOGO
    if LOGO is None:
        LOGO = Image.open(os.path.join(HERE, '..', 'logo-512.png')).convert('RGBA')
    return LOGO


def paste_logo(img, size, cx, cy, alpha):
    logo = get_logo().resize((int(size), int(size)), Image.LANCZOS)
    if alpha < 1:
        logo.putalpha(logo.getchannel('A').point(lambda v: int(v * alpha)))
    img.paste(logo, (int(cx - size / 2), int(cy - size / 2)), logo)


def centered(d, y, text, font, color, W):
    d.text(((W - font.getlength(text)) / 2, y), text, font=font, fill=color)


# ---------------------------------------------------------------- scenes

def scene_main(t, prof, fonts, captions, is_linkedin=False):
    W, H = prof['W'], prof['H']
    X0, Y0, X1, Y1, TITLE_H = prof['X0'], prof['Y0'], prof['X1'], prof['Y1'], prof['TITLE_H']
    img = Image.new('RGB', (W, H), INK)

    if t < 4.4:
        draw_window(img, 'pwsh · ~/shop', prof, fonts)
        char_w = fonts.MONO.getlength('M')
        block = text_block(X1 - X0 - 64, Y1 - Y0 - TITLE_H - 40, SHELL, t, bg=WIN, font=fonts.MONO, char_w=char_w)
        img.paste(block, (X0 + 32, Y0 + TITLE_H + 24))
    else:
        draw_window(img, 'herdr · foreman', prof, fonts)
        s = split_at(t)
        cx0, cy0, cx1, cy1 = X0 + 14, Y0 + TITLE_H + 14, X1 - 14, Y1 - 14
        full = cx1 - cx0
        lead_x1 = cx1 - (full * 0.42) * s
        draw_pane(img, (cx0, cy0, lead_x1 - 7 * s, cy1), [('lead', PAPER), (' · claude:opus', DIM)],
                  state_at(LEAD_STATES, t), LEAD, t, fonts, focus=True)
        if s > 0:
            gap = 14
            ph = (cy1 - cy0 - 2 * gap) / 3
            for i, w in enumerate(WORKERS):
                top = cy0 + i * (ph + gap)
                draw_pane(img, (lead_x1 + 7 * s, top, cx1, top + ph), [(w['name'], PAPER), (f" · {w['agent']}", DIM)],
                          state_at(w['states'], t), w['lines'], t, fonts, alpha=s)

    draw_caption(img, t, prof, fonts, captions, is_linkedin)
    return img


def scene_outro(t, outro_start, prof, fonts):
    W, H = prof['W'], prof['H']
    t_local = t - outro_start
    img = Image.new('RGB', (W, H), INK)
    d = ImageDraw.Draw(img)

    a = ease(t_local / 0.5)
    logo_size = 120 if prof['W'] == 1080 else 140
    cy_logo = H * 0.32
    paste_logo(img, logo_size * (0.9 + 0.1 * a), W / 2, cy_logo, a)

    k = ease((t_local - 0.2) / 0.4)
    cmd = f'herdr plugin install {REPO}'
    cw = fonts.MONO_BIG.getlength('$ ' + cmd)
    bx0, bx1 = (W - cw) / 2 - 28, (W + cw) / 2 + 28
    by = cy_logo + logo_size * 0.5 + 40
    d.rounded_rectangle((bx0, by, bx1, by + 60), 10,
                        fill=mix(INK, (24, 24, 30), k),
                        outline=mix(INK, WIN_BORDER, k), width=2)
    d.text((bx0 + 28, by + 14), '$ ', font=fonts.MONO_BIG, fill=mix(INK, AMBER, k))
    d.text((bx0 + 28 + fonts.MONO_BIG.getlength('$ '), by + 14), cmd, font=fonts.MONO_BIG, fill=mix(INK, PAPER, k))

    k2 = ease((t_local - 0.6) / 0.4)
    url_y = by + 80
    centered(d, url_y, f'github.com/{REPO}', fonts.SMALL, mix(INK, AMBER, k2), W)

    return img


def frame_16x9(t, prof, fonts):
    outro_start = LENGTH_16x9 - 2.0  # 2 s outro
    if t < outro_start:
        return scene_main(t, prof, fonts, CAPTIONS_16x9)
    if t < outro_start + 0.4:
        return Image.blend(scene_main(t, prof, fonts, CAPTIONS_16x9),
                           scene_outro(t, outro_start, prof, fonts),
                           ease((t - outro_start) / 0.4))
    img = scene_outro(t, outro_start, prof, fonts)
    if t > LENGTH_16x9 - 0.6:
        img = Image.blend(img, Image.new('RGB', img.size, (0, 0, 0)), clamp((t - (LENGTH_16x9 - 0.6)) / 0.6))
    return img


def frame_linkedin(nt, prof, fonts):
    """nt is LinkedIn time (0..30). Remap to original timeline."""
    t = _remap_li_inv(nt)
    outro_start_orig = 35.4
    outro_start_li = _remap_li(outro_start_orig)
    if nt < outro_start_li:
        return scene_main(t, prof, fonts, CAPTIONS_LI, is_linkedin=True)
    if nt < outro_start_li + 0.4:
        return Image.blend(scene_main(t, prof, fonts, CAPTIONS_LI, is_linkedin=True),
                           scene_outro(nt, outro_start_li, prof, fonts),
                           ease((nt - outro_start_li) / 0.4))
    img = scene_outro(nt, outro_start_li, prof, fonts)
    if nt > LENGTH_LI - 0.6:
        img = Image.blend(img, Image.new('RGB', img.size, (0, 0, 0)), clamp((nt - (LENGTH_LI - 0.6)) / 0.6))
    return img


# ---------------------------------------------------------------- SRT generation

def generate_srt(captions, path):
    """Write an SRT subtitle file for the given caption list."""
    lines = []
    for i, (t0, t1, text) in enumerate(captions, 1):
        def fmt(s):
            m, s = divmod(s, 60)
            h, m = divmod(int(m), 60)
            ms = int((s % 1) * 1000)
            return f'{h:02d}:{int(m):02d}:{int(s):02d},{ms:03d}'
        lines.append(f'{i}')
        lines.append(f'{fmt(t0)} --> {fmt(t1)}')
        lines.append(text)
        lines.append('')
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines))


# ---------------------------------------------------------------- cover image

def render_cover(path, prof, fonts):
    """1080x1350 LinkedIn cover with a clear headline."""
    W, H = 1080, 1350
    img = Image.new('RGB', (W, H), INK)
    d = ImageDraw.Draw(img)

    # Logo
    paste_logo(img, 200, W / 2, 340, 1.0)

    # Title
    title_font = load('Barlow-SemiBold.ttf', 72)
    tag_font = load('Barlow-Regular.ttf', 36)
    mono_font = load('CascadiaMono.ttf', 28)

    centered(d, 480, 'foreman', title_font, PAPER, W)
    centered(d, 580, 'One task.', tag_font, (190, 186, 178), W)
    centered(d, 630, 'A crew of coding agents.', tag_font, (190, 186, 178), W)

    # Terminal preview — a simplified snapshot
    tx0, ty0, tx1, ty1 = 60, 740, W - 60, 1100
    d.rounded_rectangle((tx0, ty0, tx1, ty1), 14, fill=WIN, outline=WIN_BORDER, width=2)
    d.rounded_rectangle((tx0 + 2, ty0 + 2, tx1 - 2, ty0 + 40), 12, fill=TITLEBAR)
    d.rectangle((tx0 + 2, ty0 + 20, tx1 - 2, ty0 + 40), fill=TITLEBAR)
    d.text(((tx0 + tx1) / 2 - mono_font.getlength('herdr · foreman') / 2, ty0 + 8),
           'herdr · foreman', font=mono_font, fill=DIM)

    small_mono = load('CascadiaMono.ttf', 22)
    preview_lines = [
        ('> foreman "fix payment security holes"', GREEN),
        ('plan   sec1 security-audit  claude:opus', FG),
        ('       test1 testing        codex', FG),
        ('3 workers · 3 git worktrees · 3 panes', GREEN),
        ('proposals', AMBER),
        ('1 [high] charge.ts: amount trusted from client', RED),
        ('2 [high] webhook.ts: signature never checked', RED),
        ('merged sec1 test1 → main', GREEN),
        ('46 passed, 0 failed', GREEN),
    ]
    for i, (text, color) in enumerate(preview_lines):
        d.text((tx0 + 20, ty0 + 54 + i * 32), text, font=small_mono, fill=color)

    # Bottom tagline
    centered(d, 1160, 'herdr plugin · github.com/Kvmyk/herdr-foreman', load('Barlow-Regular.ttf', 24), AMBER, W)

    img.save(path)


# ---------------------------------------------------------------- typing events (for music sync)

def typing_events():
    """Return list of (time, char_or_enter) for the keyboard foley sync."""
    events = []
    all_typed = []
    for lines in [SHELL, LEAD]:
        for line in lines:
            if 'type' in line:
                all_typed.append(line)
    for line in all_typed:
        start = line['t'] + 0.25
        cps = line['cps']
        text = line['type']
        for i, ch in enumerate(text):
            events.append((start + i / cps, ch))
        # Enter at the end
        events.append((start + len(text) / cps + 0.05, '\n'))
    return events


# ---------------------------------------------------------------- main

def main(argv):
    is_linkedin = '--linkedin' in argv
    argv = [a for a in argv if a != '--linkedin']

    if argv[:1] == ['--still']:
        t = float(argv[1])
        out = argv[2]
        if is_linkedin:
            prof = _profile_linkedin()
            fonts = Fonts(prof)
            frame_linkedin(t, prof, fonts).save(out)
        else:
            prof = _profile_16x9()
            fonts = Fonts(prof)
            frame_16x9(t, prof, fonts).save(out)
        return

    music, out = argv[0], argv[1]
    ffmpeg = shutil.which('ffmpeg') or sys.exit('ffmpeg not found on PATH')

    if is_linkedin:
        prof = _profile_linkedin()
        fonts = Fonts(prof)
        length = LENGTH_LI
        frame_fn = lambda t: frame_linkedin(t, prof, fonts)
    else:
        prof = _profile_16x9()
        fonts = Fonts(prof)
        length = LENGTH_16x9
        frame_fn = lambda t: frame_16x9(t, prof, fonts)

    W, H, FPS = prof['W'], prof['H'], prof['FPS']

    proc = subprocess.Popen([
        ffmpeg, '-y', '-loglevel', 'error',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
        '-i', music,
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-tune', 'animation',
        '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out,
    ], stdin=subprocess.PIPE)
    total = int(length * FPS)
    for i in range(total):
        proc.stdin.write(frame_fn(i / FPS).tobytes())
        if i % (FPS * 5) == 0:
            print(f'{i / FPS:4.0f} s', flush=True)
    proc.stdin.close()
    sys.exit(proc.wait())


if __name__ == '__main__':
    main(sys.argv[1:])
