import sys, json, base64, re
import cv2
import numpy as np


def decode(b64):
    if not b64:
        return None
    b64 = re.sub(r'^data:image/\w+;base64,', '', b64)
    raw = base64.b64decode(b64)
    return cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)


def parse_task(prompt):
    t = (prompt or '').lower()
    m = re.search(r'\b(\d+)\b', prompt or '')
    n = int(m.group(1)) if m else 2
    if 'lying' in t or 'on their side' in t or 'on its side' in t:
        return 'lying', n
    if 'upside' in t or 'on their head' in t or 'on its head' in t:
        return 'upside', n
    big = ('biggest' in t or 'largest' in t)
    small = ('smallest' in t or 'tiniest' in t)
    if big and small:
        return 'biggest_smallest', 2
    if big:
        return 'biggest', n
    if small:
        return 'smallest', n
    if 'no wing' in t or 'no wings' in t:
        return 'no_wings', n
    if 'wing' in t:
        return 'wings', n
    if 'missing' in t:
        return 'missing', n
    if 'extra' in t:
        return 'extra', n
    if 'arms' in t and 'legs' in t:
        return 'arms_legs', n
    if 'eye' in t:
        return 'eyes', n
    if 'stripe' in t:
        return 'stripes', n
    if 'different body' in t or 'different' in t:
        return 'different_body', n
    if 'twin' in t or 'identical' in t or 'same parts' in t or 'same' in t or 'match' in t:
        return 'twins', n
    return 'unknown', n


def sat_mask(hsv):
    S = hsv[:, :, 1]
    V = hsv[:, :, 2]
    return (((S > 85) & (V > 55)) | ((V < 95) & (S > 35))).astype(np.uint8)


def segment(img):
    H, W = img.shape[:2]
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    S = hsv[:, :, 1]
    V = hsv[:, :, 2]
    base = (((S > 85) & (V > 55)) | ((V < 95) & (S > 35))).astype(np.uint8)
    dark = (V < 90)
    cols, rows = 4, 2
    cw, ch = W / cols, H / rows
    comps = []
    for r in range(rows):
        for c in range(cols):
            x0, x1 = int(c * cw), int((c + 1) * cw)
            y0, y1 = int(r * ch), int((r + 1) * ch)
            m = int(min(cw, ch) * 0.25)
            cx0, cx1 = max(0, x0 - m), min(W, x1 + m)
            cy0, cy1 = max(0, y0 - m), min(H, y1 + m)
            sb = base[cy0:cy1, cx0:cx1] * 255
            sd = dark[cy0:cy1, cx0:cx1]
            sb = cv2.morphologyEx(sb, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
            n, lab, st, ct = cv2.connectedComponentsWithStats(sb)
            ccx, ccy = (x0 + x1) / 2, (y0 + y1) / 2
            best = None
            for i in range(1, n):
                a = int(st[i, 4])
                if a < 450:
                    continue
                x, y, w, h = int(st[i, 0]), int(st[i, 1]), int(st[i, 2]), int(st[i, 3])
                dk = int(sd[y:y + h, x:x + w].sum())
                if dk < 8:
                    continue
                gcx, gcy = ct[i][0] + cx0, ct[i][1] + cy0
                if not (x0 - 18 <= gcx <= x1 + 18 and y0 - 18 <= gcy <= y1 + 18):
                    continue
                d = (gcx - ccx) ** 2 + (gcy - ccy) ** 2
                if best is None or d < best[0]:
                    best = (d, dict(x=x + cx0, y=y + cy0, w=w, h=h, area=a,
                                    cx=float(gcx), cy=float(gcy), dark=dk))
            if best:
                comps.append(best[1])
    return hsv, comps


def _round(ar, lo, hi):
    return lo <= ar <= hi


def pupils(hsv, comp):
    """Eyes = white sclera blob with a compact dark pupil inside.
    Excludes striped legs / crowns / mouth / background corners."""
    x, y, w, h = comp['x'], comp['y'], comp['w'], comp['h']
    sub = hsv[y:y + h, x:x + w]
    S = sub[:, :, 1]
    V = sub[:, :, 2]
    white = ((V > 160) & (S < 100)).astype(np.uint8) * 255
    white = cv2.morphologyEx(white, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    dark = (V < 115).astype(np.uint8) * 255
    nw, lw, sw, cw = cv2.connectedComponentsWithStats(white)
    eyes = []
    for j in range(1, nw):
        bx, by, bw, bh, ba = int(sw[j, 0]), int(sw[j, 1]), int(sw[j, 2]), int(sw[j, 3]), int(sw[j, 4])
        if ba < 8 or ba > w * h * 0.06:
            continue
        if bx < 2 or by < 2 or bx + bw > w - 2 or by + bh > h - 2:
            continue
        ar = bw / (bh + 1e-6)
        fill = ba / (bw * bh + 1e-6)
        if not _round(ar, 0.5, 2.0) or fill < 0.42:
            continue
        reg = dark[by:by + bh, bx:bx + bw]
        nd, ld, sd, cd = cv2.connectedComponentsWithStats(reg)
        best = None
        for k in range(1, nd):
            px, py, pw, ph, pa = int(sd[k, 0]), int(sd[k, 1]), int(sd[k, 2]), int(sd[k, 3]), int(sd[k, 4])
            if pa < 3:
                continue
            par = pw / (ph + 1e-6)
            pfill = pa / (pw * ph + 1e-6)
            if not _round(par, 0.4, 2.3) or pfill < 0.38:
                continue
            frac = pa / (ba + 1e-6)
            if frac < 0.05 or frac > 0.80:
                continue
            ddx = abs((px + pw / 2) - bw / 2) / (bw + 1e-6)
            ddy = abs((py + ph / 2) - bh / 2) / (bh + 1e-6)
            if ddx > 0.55 or ddy > 0.55:
                continue
            if best is None or pa > best[0]:
                best = (pa, float(cd[k][0]), float(cd[k][1]))
        if best is not None:
            eyes.append((cw[j][0] + x, cw[j][1] + y, ba))
    if eyes:
        return eyes
    # fallback: compact dark blobs (eyes without white sclera)
    dark2 = (V < 90).astype(np.uint8) * 255
    nd, ld, sd, cd = cv2.connectedComponentsWithStats(dark2)
    out = []
    for k in range(1, nd):
        bx, by, bw, bh, ba = int(sd[k, 0]), int(sd[k, 1]), int(sd[k, 2]), int(sd[k, 3]), int(sd[k, 4])
        if ba < 5 or ba > w * h * 0.02:
            continue
        ar = bw / (bh + 1e-6)
        fill = ba / (bw * bh + 1e-6)
        if not _round(ar, 0.5, 2.0) or fill < 0.45:
            continue
        out.append((cd[k][0] + x, cd[k][1] + y, ba))
    return out


def scores(comp, ey):
    if not ey:
        return 0.0, 0.0
    ex = sum(p[0] for p in ey) / len(ey)
    eyc = sum(p[1] for p in ey) / len(ey)
    ndx = (ex - comp['cx']) / (comp['w'] / 2 + 1e-6)
    ndy = (eyc - comp['cy']) / (comp['h'] / 2 + 1e-6)
    return ndx, ndy


def label(ndx, ndy):
    if abs(ndx) > abs(ndy) * 1.2:
        return 'lying'
    if ndy < 0:
        return 'standing'
    return 'upside'


def hu_of(mask_region):
    m = cv2.moments(mask_region, binaryImage=True)
    hu = cv2.HuMoments(m).flatten()
    hu = np.where(np.abs(hu) > 1e-30, hu, 1e-30)
    return -np.sign(hu) * np.log10(np.abs(hu))


def ref_mask(ref):
    hsv = cv2.cvtColor(ref, cv2.COLOR_BGR2HSV)
    V = hsv[:, :, 2]
    S = hsv[:, :, 1]
    fg = ((V < 205) | (S > 55)).astype(np.uint8) * 255
    fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    n, lab, stats, cent = cv2.connectedComponentsWithStats(fg)
    if n <= 1:
        return None
    i = 1 + int(np.argmax(stats[1:, 4]))
    x, y, w, h, a = stats[i]
    if a < 200:
        return None
    return (lab[y:y + h, x:x + w] == i).astype(np.uint8)


def solve(img, ref, prompt):
    task, n = parse_task(prompt)
    hsv, comps = segment(img)
    H, W = img.shape[:2]

    info = []
    for c in comps:
        ey = pupils(hsv, c)
        ndx, ndy = scores(c, ey)
        info.append(dict(c=c, ori=label(ndx, ndy), ndx=ndx, ndy=ndy, n=len(ey)))

    def pt(c):
        return [int(round(c['cx'])), int(round(c['cy']))]

    sel = []
    if task == 'biggest_smallest':
        order = sorted(info, key=lambda z: z['c']['area'])
        sel = [order[-1]['c'], order[0]['c']]
    elif task in ('biggest', 'smallest'):
        order = sorted(info, key=lambda z: z['c']['area'], reverse=(task == 'biggest'))
        sel = [z['c'] for z in order[:max(1, n)]]
    elif task == 'lying':
        order = sorted(info, key=lambda z: abs(z['ndx']) - abs(z['ndy']), reverse=True)
        sel = [z['c'] for z in order[:max(2, n)]]
    elif task == 'upside':
        order = sorted(info, key=lambda z: z['ndy'], reverse=True)
        sel = [z['c'] for z in order[:max(2, n)]]
    elif task == 'eyes':
        order = sorted(info, key=lambda z: z['n'], reverse=True)
        sel = [z['c'] for z in order[:max(2, n)]]
    elif task == 'twins':
        rm = ref_mask(ref) if ref is not None else None
        if rm is not None and rm.size > 0:
            rhu = hu_of(rm)
            scored = []
            for z in info:
                c = z['c']
                cs = hsv[c['y']:c['y'] + c['h'], c['x']:c['x'] + c['w']]
                chu = hu_of(sat_mask(cs))
                dist = float(np.sum(np.abs(chu - rhu)))
                scored.append((dist, c))
            scored.sort(key=lambda z: z[0])
            sel = [c for _, c in scored[:max(2, n)]]
        else:
            hus = []
            for z in info:
                c = z['c']
                cs = hsv[c['y']:c['y'] + c['h'], c['x']:c['x'] + c['w']]
                hus.append((z['c'], hu_of(sat_mask(cs))))
            best = None
            for i in range(len(hus)):
                for j in range(i + 1, len(hus)):
                    dd = float(np.sum(np.abs(hus[i][1] - hus[j][1])))
                    if best is None or dd < best[0]:
                        best = (dd, [hus[i][0], hus[j][0]])
            sel = best[1] if best else []
    else:
        sel = [z['c'] for z in info]

    pts = [pt(c) for c in sel]
    out = {
        'ok': len(pts) > 0, 'task': task, 'want': n, 'w': W, 'h': H,
        'found': len(comps), 'points': pts,
        'answer': ';'.join(f'{x},{y}' for x, y in pts),
        'detail': [{'p': pt(z['c']), 'area': z['c']['area'], 'ori': z['ori'],
                    'ndx': round(z['ndx'], 2), 'ndy': round(z['ndy'], 2),
                    'w': z['c']['w'], 'h': z['c']['h'],
                    'eyes': z['n']} for z in info],
    }
    return out


def main():
    d = json.loads(sys.stdin.read())
    img = decode(d.get('image', ''))
    if img is None:
        print(json.dumps({'ok': False, 'error': 'no-image'}))
        return
    ref = decode(d.get('ref', ''))
    print(json.dumps(solve(img, ref, d.get('prompt', ''))))


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)}))
