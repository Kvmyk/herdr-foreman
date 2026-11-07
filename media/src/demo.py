"""Render the foreman demo: frames drawn with Pillow, piped to ffmpeg.

    python media/src/music.py music.wav
    python media/src/demo.py music.wav media/demo.mp4                  # 16:9, README
    python media/src/music.py music-li.wav --linkedin
    python media/src/demo.py music-li.wav media/demo-linkedin.mp4 --linkedin
    python media/src/demo.py --srt media/demo-linkedin.srt --linkedin   # captions as SRT
    python media/src/demo.py --cover media/demo-linkedin-cover.png      # 1080x1350 cover
    python media/src/demo.py --still 12 frame.png [--linkedin]          # one frame, for checking

Needs Pillow, numpy, ffmpeg on PATH and the Cascadia Mono font (Windows).
Barlow (SIL OFL) is vendored in media/src/fonts; the outro lockup comes from
brand.py. FOREMAN_REPO sets the GitHub repo shown at the end.
The run shown follows foreman's real flow and command names; the repository,
findings and commit ids are made up.

All events below are on one story clock. Each cut maps video time to story
time piecewise (the LinkedIn cut shortens the two waits), and captions, the
SRT and the key clicks in music.py are placed on the cut's video clock.
"""
import os
import re
import shutil
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

import brand

REPO = os.environ.get('FOREMAN_REPO', 'Kvmyk/herdr-foreman')
HERE = os.path.dirname(os.path.abspath(__file__))
FONT_DIRS = [os.path.join(HERE, 'fonts'),
             os.path.join(os.environ.get('WINDIR', 'C:/Windows'), 'Fonts'),
             os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Microsoft', 'Windows', 'Fonts')]

INK, PAPER, AMBER = brand.INK, brand.PAPER, brand.AMBER
FG, DIM, MUTED = (214, 211, 204), (128, 126, 121), (190, 186, 178)
GREEN, BLUE, VIOLET, RED = (52, 211, 153), (56, 189, 248), (192, 132, 252), (248, 113, 113)
WIN, WIN_BORDER, TITLEBAR = (22, 22, 26), (46, 46, 54), (28, 28, 33)
PANE, PANE_BORDER, PANE_FOCUS = (24, 24, 29), (46, 46, 54), (104, 102, 98)
STATE_COLOR = {'starting': DIM, 'working': AMBER, 'done': GREEN, 'idle': BLUE}
STATE_LABEL = {'starting': 'starting', 'working': 'working', 'done': 'done', 'idle': 'waiting for you'}


def load(name, size, variation=None):
    for d in FONT_DIRS:
        p = os.path.join(d, name)
        if os.path.exists(p):
            f = ImageFont.truetype(p, size)
            if variation:
                f.set_variation_by_name(variation)
            return f
    raise SystemExit(f'font {name} not found')


# ---------------------------------------------------------------- cuts

CUTS = {
    # Window, pane layout, terminal font and caption placement per format.
    # 'map' pairs (story time, video time); the main scene ends at the last
    # pair and a 2 s outro follows.
    'wide': dict(W=1920, H=1080, window=(100, 40, 1820, 870), layout='side',
                 mono=24, line_h=34, cap_size=36, cap_y=930, lockup=0.9,
                 map=[(2.6, 0.0), (32.6, 30.0)]),
    # 4:5 feed video: caption on top, clear of the player controls at the
    # bottom; lead pane full width on top, workers stacked below it.
    'linkedin': dict(W=1080, H=1350, window=(24, 160, 1056, 1318), layout='stack',
                     mono=25, line_h=35, cap_size=40, cap_y=92, lockup=0.84,
                     map=[(2.6, 0.0), (11.3, 8.7), (15.5, 11.9), (20.2, 16.6), (24.4, 19.8), (31.6, 27.0)]),
}
FPS, OUTRO, TITLE_H = 30, 2.0, 46


def main_end(cut):
    return CUTS[cut]['map'][-1][1]


def length(cut):
    return main_end(cut) + OUTRO


def to_video(cut, t):
    m = CUTS[cut]['map']
    for (t0, v0), (t1, v1) in zip(m, m[1:]):
        if t <= t1:
            return v0 + (v1 - v0) * (t - t0) / (t1 - t0)
    return m[-1][1] + t - m[-1][0]


def to_story(cut, v):
    m = CUTS[cut]['map']
    for (t0, v0), (t1, v1) in zip(m, m[1:]):
        if v <= v1:
            return t0 + (t1 - t0) * (v - v0) / (v1 - v0)
    return m[-1][0] + v - m[-1][1]


# ---------------------------------------------------------------- the run (story time)

def L(t, *spans):
    return {'t': t, 'spans': list(spans)}


def TYPED(t, prefix, text, cps, color=FG):
    return {'t': t, 'spans': [prefix], 'type': text, 'cps': cps, 'color': color}


TASK = 'fix-payment-security-holes'
ENTER = 3.2                         # the opening command is already typed; Enter here

SHELL = [
    L(-9, ('~/shop ', BLUE), ('main', VIOLET)),
    dict(L(-9, ('> ', GREEN), ('foreman "fix payment security holes"', PAPER)), cursor_until=ENTER),
    L(3.5, (f'Leader "lead" (claude) started in pane w1:p1 for task "{TASK}".', DIM)),
]

LEAD = [
    L(4.7, ('$ ', DIM), ('foreman brief --json', FG)),
    L(5.3, ('agents  ', DIM), ('claude ✓', GREEN), ('  codex ✓', GREEN), ('  opencode ✓', GREEN), ('  gemini –', DIM)),
    L(5.9, ('', FG)),
    L(6.0, ('plan', AMBER), ('   part   category        agent         effort', DIM)),
    L(6.3, ('       sec1   ', BLUE), ('security-audit  ', FG), ('claude:opus   ', VIOLET), ('high', FG)),
    L(6.6, ('       test1  ', BLUE), ('testing         ', FG), ('codex         ', VIOLET), ('medium', FG)),
    L(6.9, ('       deps1  ', BLUE), ('security-audit  ', FG), ('opencode      ', VIOLET), ('low', FG)),
    TYPED(7.5, ('$ ', DIM), f'foreman spawn --task {TASK} …', 34),
    L(9.3, ('3 workers · 3 git worktrees · 3 panes', GREEN)),
    L(10.8, ('$ ', DIM), ('herdr agent prompt ×3', FG), ('  investigate only, change nothing', DIM)),
    L(11.3, ('$ ', DIM), (f'foreman wait --task {TASK}', FG)),
    L(15.5, ('done  ', GREEN), ('sec1 test1 deps1', FG)),
    L(15.8, ('', FG)),
    L(15.9, ('proposals', AMBER)),
    L(16.2, ('1 ', PAPER), ('[high] ', RED), ('charge.ts: amount trusted from client  ', FG), ('sec1', DIM)),
    L(16.5, ('2 ', PAPER), ('[high] ', RED), ('webhook.ts: signature never checked    ', FG), ('sec1', DIM)),
    L(16.8, ('3 ', PAPER), ('[med]  ', AMBER), ('refund paths have no tests             ', FG), ('test1', DIM)),
    L(17.1, ('4 ', PAPER), ('[low]  ', BLUE), ('payment-sdk 2.1: advisory -> 2.4       ', FG), ('deps1', DIM)),
    L(17.6, ('Which items should I do?', PAPER)),
    TYPED(18.0, ('› ', AMBER), '1, 2 and 3 yes, 4 no', 15, PAPER),
    L(20.2, ('$ ', DIM), ('foreman wait --phase implement', FG)),
    L(24.4, ('$ ', DIM), (f'foreman merge --task {TASK}', FG)),
    L(24.9, ('merged ', GREEN), ('sec1 test1', FG), (f' → foreman/{TASK}', DIM)),
    L(25.4, ('$ ', DIM), ('npm test', FG)),
    L(25.9, ('46 passed', GREEN), (', 0 failed', DIM)),
    L(26.4, ('', FG)),
    L(26.5, ('3 changes in 4 files, tests pass. What now?', PAPER)),
    L(26.9, ('1 ', AMBER), ('merge into main   ', FG), ('2 ', AMBER), ('leave the branch   ', FG), ('3 ', AMBER), ('comments', FG)),
    TYPED(27.6, ('› ', AMBER), '1', 6, PAPER),
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

# (story start, story end, 16:9 text, 4:5 text); the 4:5 lines are shorter so
# they fit one line at the larger size.
CAPTIONS = [
    (2.6, 4.3, 'Describe the task in plain words.', 'Describe the task in plain words.'),
    (4.6, 9.7, 'The leader checks your agents and splits the work.', 'The leader splits the work.'),
    (10.0, 15.6, 'Each worker investigates in its own worktree. Nothing changes yet.', 'Workers investigate. Nothing changes yet.'),
    (16.0, 20.0, 'You approve what gets done.', 'You approve what gets done.'),
    (20.2, 26.2, 'Workers implement, test and commit in their worktrees.', 'Workers implement, test and commit.'),
    (26.5, 31.2, 'Nothing is pushed. You decide what lands.', 'Nothing is pushed. You decide.'),
]


def captions(cut):
    """Captions on the cut's video clock: (start, end, text)."""
    i = 2 if cut == 'wide' else 3
    out = []
    for c in CAPTIONS:
        v0, v1 = to_video(cut, c[0]), min(to_video(cut, c[1]), main_end(cut))
        out.append((round(v0, 2), round(v1, 2), c[i]))
    return out


def typing_events(cut):
    """(video time, char) for the key clicks in music.py; '\\n' is Enter."""
    events = [(ENTER, '\n')]
    for line in SHELL + LEAD:
        if 'type' in line:
            start = line['t'] + 0.25
            events += [(start + i / line['cps'], ch) for i, ch in enumerate(line['type'])]
            events.append((start + len(line['type']) / line['cps'] + 0.05, '\n'))
    return sorted((to_video(cut, t), ch) for t, ch in events if 0 <= to_video(cut, t) < main_end(cut))


# ---------------------------------------------------------------- helpers

def clamp(v, lo=0.0, hi=1.0):
    return max(lo, min(hi, v))


def ease(v):
    v = clamp(v)
    return 1 - (1 - v) ** 3


def mix(a, b, k):
    return tuple(int(a[i] + (b[i] - a[i]) * k) for i in range(3))


def state_at(states, t):
    current = None
    for when, s in states:
        if t >= when:
            current = s
    return current


def split_at(t):
    """0 = the leader fills the window, 1 = workers shown."""
    if t < 9.8:
        return 0.0
    if t < 30.6:
        return ease((t - 9.8) / 0.7)
    return 1 - ease((t - 30.6) / 0.6)


class Fonts:
    def __init__(self, c):
        self.mono = load('CascadiaMono.ttf', c['mono'])
        self.mono_b = load('CascadiaMono.ttf', c['mono'], 'Bold')
        self.mono_big = load('CascadiaMono.ttf', round(c['mono'] * 1.45))
        self.caption = load('Barlow-SemiBold.ttf', c['cap_size'])
        self.small = load('Barlow-Regular.ttf', round(c['mono'] * 1.2))
        self.win_title = load('Barlow-Regular.ttf', 22)
        self.line_h = c['line_h']


# ---------------------------------------------------------------- drawing

def spans_at(line, t, bg):
    """Spans of a line at time t, faded in from bg, plus whether to draw a cursor."""
    k = clamp((t - line['t']) / 0.18)
    spans = [(text, mix(bg, color, k)) for text, color in line['spans']]
    cursor = t < line.get('cursor_until', -1)
    if 'type' in line:
        start = line['t'] + 0.25
        n = int(clamp((t - start) * line['cps'], 0, len(line['type'])))
        spans.append((line['type'][:n], mix(bg, line['color'], k)))
        cursor = t < start + len(line['type']) / line['cps'] + 0.4
    return spans, cursor


def wrap(spans, font, width):
    """Word-wrap spans into rows no wider than width, like a terminal that
    breaks at spaces; a word longer than a row is split."""
    rows, row, x = [], [], 0.0
    for text, color in spans:
        for tok in re.findall(r'\S+\s*|\s+', text):
            w = font.getlength(tok.rstrip())
            if x > 0 and x + w > width:
                rows.append(row)
                row, x = [], 0.0
                tok = tok.lstrip()
                if not tok:
                    continue
            while font.getlength(tok.rstrip()) > width:
                n = max(1, int(width // font.getlength('M')))
                rows.append(row + [(tok[:n], color)])
                row, tok = [], tok[n:]
            row.append((tok, color))
            x += font.getlength(tok)
    rows.append(row)
    return rows


def text_block(w, h, lines, t, bg, font, lh):
    """Render the visible lines into a w x h image, wrapped and scrolled to the bottom."""
    img = Image.new('RGB', (w, h), bg)
    d = ImageDraw.Draw(img)
    char_w = font.getlength('M')
    if w < 8 * char_w:              # a pane still opening
        return img
    rows = []
    for ln in lines:
        if t >= ln['t']:
            spans, cursor = spans_at(ln, t, bg)
            r = wrap(spans, font, w - char_w)
            rows += [(row, False) for row in r[:-1]] + [(r[-1], cursor)]
    for i, (row, cursor) in enumerate(rows[-max(1, h // lh):]):
        x, y = 0, i * lh
        for text, color in row:
            d.text((x, y), text, font=font, fill=color)
            x += font.getlength(text)
        if cursor:
            d.rectangle((x + 2, y + lh * 0.09, x + char_w - 1, y + lh * 0.8), fill=FG)
    return img


def draw_pane(img, box, title, state, lines, t, fonts, focus=False, alpha=1.0):
    x0, y0, x1, y1 = (round(v) for v in box)
    w, h = x1 - x0, y1 - y0
    if w < 40 or h < 60 or alpha <= 0:
        return
    pane = Image.new('RGB', (w, h), WIN)
    d = ImageDraw.Draw(pane)
    d.rounded_rectangle((0, 0, w - 1, h - 1), 12, fill=mix(WIN, PANE, alpha),
                        outline=mix(WIN, PANE_FOCUS if focus else PANE_BORDER, alpha), width=2)
    hx = 18
    for text, color in title:
        d.text((hx, 10), text, font=fonts.mono_b if color == PAPER else fonts.mono, fill=mix(PANE, color, alpha))
        hx += fonts.mono.getlength(text)
    if state:
        label, color = STATE_LABEL[state], STATE_COLOR[state]
        lw = fonts.mono.getlength(label)
        d.text((w - 18 - lw, 10), label, font=fonts.mono, fill=mix(PANE, color, alpha))
        cx, cy = w - 34 - lw, 24
        d.ellipse((cx - 7, cy - 7, cx + 7, cy + 7), fill=mix(PANE, color, alpha))
    d.line((2, TITLE_H, w - 3, TITLE_H), fill=mix(PANE, PANE_BORDER, alpha), width=1)
    inner = text_block(max(1, w - 36), max(1, h - TITLE_H - 18), lines, t, PANE, fonts.mono, fonts.line_h)
    if alpha < 1:
        inner = Image.blend(Image.new('RGB', inner.size, PANE), inner, alpha)
    pane.paste(inner, (18, TITLE_H + 12))
    img.paste(pane, (x0, y0))


def draw_window(img, c, title, fonts):
    X0, Y0, X1, Y1 = c['window']
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((X0, Y0, X1, Y1), 18, fill=WIN, outline=WIN_BORDER, width=2)
    d.rounded_rectangle((X0 + 2, Y0 + 2, X1 - 2, Y0 + TITLE_H), 16, fill=TITLEBAR)
    d.rectangle((X0 + 2, Y0 + 24, X1 - 2, Y0 + TITLE_H), fill=TITLEBAR)
    d.line((X0 + 2, Y0 + TITLE_H, X1 - 2, Y0 + TITLE_H), fill=WIN_BORDER, width=2)
    tw = fonts.win_title.getlength(title)
    d.text(((X0 + X1 - tw) / 2, Y0 + 10), title, font=fonts.win_title, fill=DIM)


def pane_boxes(c, s):
    """Lead box and three worker boxes for split amount s."""
    X0, Y0, X1, Y1 = c['window']
    cx0, cy0, cx1, cy1 = X0 + 14, Y0 + TITLE_H + 14, X1 - 14, Y1 - 14
    gap = 14
    if c['layout'] == 'side':
        lead_x1 = cx1 - (cx1 - cx0) * 0.42 * s
        ph = (cy1 - cy0 - 2 * gap) / 3
        workers = [(lead_x1 + gap / 2 * s, cy0 + i * (ph + gap), cx1, cy0 + i * (ph + gap) + ph) for i in range(3)]
        return (cx0, cy0, lead_x1 - gap / 2 * s, cy1), workers
    # stack: workers get four rows each, the lead the rest
    wh = TITLE_H + 18 + 4 * c['line_h']
    lead_y1 = cy1 - (3 * wh + 3 * gap) * s
    workers = [(cx0, lead_y1 + gap * s + i * (wh + gap), cx1, lead_y1 + gap * s + i * (wh + gap) + wh) for i in range(3)]
    return (cx0, cy0, cx1, lead_y1), workers


def scene_main(t, c, fonts):
    """The terminal at story time t."""
    X0, Y0, X1, Y1 = c['window']
    img = Image.new('RGB', (c['W'], c['H']), INK)
    if t < 4.4:
        draw_window(img, c, 'pwsh · ~/shop', fonts)
        # zoomed in, so the command reads on the first frame
        block = text_block(X1 - X0 - 72, Y1 - Y0 - TITLE_H - 48, SHELL, t, WIN, fonts.mono_big,
                           round(fonts.line_h * 1.45))
        img.paste(block, (X0 + 36, Y0 + TITLE_H + 30))
        return img
    draw_window(img, c, 'herdr · foreman', fonts)
    s = split_at(t)
    lead, workers = pane_boxes(c, s)
    draw_pane(img, lead, [('lead', PAPER), (' · claude:opus', DIM)], state_at(LEAD_STATES, t), LEAD, t, fonts, focus=True)
    if s > 0:
        for box, w in zip(workers, WORKERS):
            draw_pane(img, box, [(w['name'], PAPER), (f" · {w['agent']}", DIM)],
                      state_at(w['states'], t), w['lines'], t, fonts, alpha=s)
    return img


def draw_caption(img, v, c, fonts, caps):
    d = ImageDraw.Draw(img)
    for v0, v1, text in caps:
        if v0 <= v <= v1:
            k = min(1.0 if v0 == 0 else ease((v - v0) / 0.3), ease((v1 - v) / 0.25))
            d.text((c['W'] / 2, c['cap_y'] + (1 - k) * 6), text, font=fonts.caption,
                   fill=mix(INK, PAPER, k), anchor='mm')


def scene_outro(u, c, fonts):
    """u seconds into the outro: the lockup as on the banner, the install command, the URL."""
    W, H = c['W'], c['H']
    img = Image.new('RGB', (W, H), INK)
    s = c['lockup']
    lock_w, top = brand.lockup_metrics(s)
    cmd = f'herdr plugin install {REPO}'
    box_h = round(fonts.mono_big.size * 1.9)
    block_h = top + 70 + box_h + 40 + fonts.small.size
    base = (H - block_h) / 2 + top
    lock = Image.new('RGB', (W, H), INK)
    brand.draw_lockup(lock, (W - lock_w) / 2, base, s, PAPER)
    img = Image.blend(img, lock, ease(u / 0.4))
    d = ImageDraw.Draw(img)

    k = ease((u - 0.3) / 0.4)
    cw = fonts.mono_big.getlength('$ ' + cmd)
    bx0, bx1, by = (W - cw) / 2 - 28, (W + cw) / 2 + 28, base + 70
    d.rounded_rectangle((bx0, by, bx1, by + box_h), 10, fill=mix(INK, WIN, k), outline=mix(INK, WIN_BORDER, k), width=2)
    d.text((bx0 + 28, by + box_h / 2), '$ ', font=fonts.mono_big, fill=mix(INK, AMBER, k), anchor='lm')
    d.text((bx0 + 28 + fonts.mono_big.getlength('$ '), by + box_h / 2), cmd, font=fonts.mono_big,
           fill=mix(INK, PAPER, k), anchor='lm')
    k = ease((u - 0.6) / 0.4)
    d.text((W / 2, by + box_h + 40), f'github.com/{REPO}', font=fonts.small, fill=mix(INK, MUTED, k), anchor='mt')
    return img


def frame(cut, v, fonts, caps):
    c, end = CUTS[cut], main_end(cut)
    if v < end:
        img = scene_main(to_story(cut, v), c, fonts)
        draw_caption(img, v, c, fonts, caps)
        return img
    img = scene_outro(v - end, c, fonts)
    if v - end < 0.3:
        img = Image.blend(scene_main(to_story(cut, end), c, fonts), img, ease((v - end) / 0.3))
    return img


# ---------------------------------------------------------------- SRT and cover

def write_srt(cut, path):
    def ts(v):
        ms = round(v * 1000)
        return f'{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}'
    out = [f'{i}\n{ts(v0)} --> {ts(v1)}\n{text}\n' for i, (v0, v1, text) in enumerate(captions(cut), 1)]
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(out))


def render_cover(path):
    """1080x1350 cover: the lockup, the tagline and the 4:5 terminal at the approval step."""
    c = CUTS['linkedin']
    W, H = c['W'], c['H']
    img = Image.new('RGB', (W, H), INK)
    lock_w, top = brand.lockup_metrics(0.84)
    base = 70 + top
    brand.draw_lockup(img, (W - lock_w) / 2, base, 0.84, PAPER)
    d = ImageDraw.Draw(img)
    d.text((W / 2, base + 70), 'One task. A crew of coding agents.', font=load('Barlow-Regular.ttf', 44),
           fill=MUTED, anchor='ms')
    X0, Y0, X1, Y1 = c['window']
    term = scene_main(20.0, c, Fonts(c)).crop((X0, Y0, X1 + 1, Y1 + 1))
    y = round(base + 124)
    k = min((W - 2 * 60) / term.width, (H - 56 - y) / term.height)
    term = term.resize((round(term.width * k), round(term.height * k)), Image.LANCZOS)
    img.paste(term, ((W - term.width) // 2, y))
    img.save(path)


# ---------------------------------------------------------------- main

def main(argv):
    cut = 'linkedin' if '--linkedin' in argv else 'wide'
    argv = [a for a in argv if a != '--linkedin']
    c = CUTS[cut]
    if argv[:1] == ['--srt']:
        return write_srt(cut, argv[1])
    if argv[:1] == ['--cover']:
        return render_cover(argv[1])
    fonts, caps = Fonts(c), captions(cut)
    if argv[:1] == ['--still']:
        return frame(cut, float(argv[1]), fonts, caps).save(argv[2])

    music, out = argv[0], argv[1]
    ffmpeg = shutil.which('ffmpeg') or sys.exit('ffmpeg not found on PATH')
    proc = subprocess.Popen([
        ffmpeg, '-y', '-loglevel', 'error',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f"{c['W']}x{c['H']}", '-r', str(FPS), '-i', '-',
        '-i', music,
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-tune', 'animation',
        '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out,
    ], stdin=subprocess.PIPE)
    total = round(length(cut) * FPS)
    for i in range(total):
        proc.stdin.write(frame(cut, i / FPS, fonts, caps).tobytes())
        if i % (FPS * 5) == 0:
            print(f'{i / FPS:4.0f} s', flush=True)
    proc.stdin.close()
    sys.exit(proc.wait())


if __name__ == '__main__':
    main(sys.argv[1:])
