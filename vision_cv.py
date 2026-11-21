import sys, json, base64, re, os
import cv2
import numpy as np
import torch, timm, open_clip
from PIL import Image
import torchvision.transforms as T

W, H = 450, 280
G = 518 // 14
CENTERS = [(int((c + 0.5) * W / 4), int((r + 0.5) * H / 2)) for r in range(2) for c in range(4)]

def imread(p): return cv2.imdecode(np.fromfile(p, dtype=np.uint8), cv2.IMREAD_COLOR)
def cells(sc): return [sc[max(0, cy - 72):min(H, cy + 72), max(0, cx - 60):min(W, cx + 60)] for cx, cy in CENTERS]

def fgmask(im):
    hsv = cv2.cvtColor(im, cv2.COLOR_BGR2HSV); S = hsv[:, :, 1]; V = hsv[:, :, 2]
    m = (((S > 90) & (V > 50)) | (V < 90)).astype(np.uint8)
    return cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))

def largest_comp(m):
    n, lab, st, ct = cv2.connectedComponentsWithStats(m)
    if n <= 1: return None, None
    i = 1 + int(np.argmax(st[1:, 4]))
    return (lab == i).astype(np.uint8) * 255, st[i]

def torso_mask(crop):
    m, st = largest_comp(fgmask(crop))
    if m is None: return m
    for k in (11, 9, 7, 5):
        t = cv2.erode(m, np.ones((k, k), np.uint8))
        t2, st2 = largest_comp(t)
        if t2 is not None and st2 is not None and st2[4] > 120:
            return t2
    return m

def area_of(crop):
    m, st = largest_comp(fgmask(crop))
    return int(st[4]) if st is not None else 0

def angle_of(crop):
    m, st = largest_comp(fgmask(crop))
    if m is None: return 90.0
    ys, xs = np.where(m > 0)
    if len(xs) < 10: return 90.0
    pts = np.stack([xs, ys], 1).astype(np.float32)
    _, eig, _ = cv2.PCACompute2(pts, mean=None)
    return float(np.degrees(np.arctan2(eig[0, 1], eig[0, 0]))) % 180

def body_desc(crop):
    t = torso_mask(crop)
    if t is None: return np.zeros(6, np.float32)
    cnts, _ = cv2.findContours(t, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts: return np.zeros(6, np.float32)
    c = max(cnts, key=cv2.contourArea)
    a = cv2.contourArea(c)
    if a < 50: return np.zeros(6, np.float32)
    x, y, w, h = cv2.boundingRect(c)
    peri = cv2.arcLength(c, True)
    ha = cv2.contourArea(cv2.convexHull(c))
    circ = 4 * np.pi * a / (peri * peri + 1e-6)
    sol = a / (ha + 1e-6)
    ap = cv2.approxPolyDP(c, 0.03 * peri, True)
    return np.array([w / (h + 1e-6), a / (w * h + 1e-6), circ, sol, len(ap) / 10.0, a / 5000.0], np.float32)

def radial(crop):
    m, st = largest_comp(fgmask(crop))
    if m is None: return None
    M = cv2.moments(m)
    if M['m00'] == 0: return None
    cx = M['m10'] / M['m00']; cy = M['m01'] / M['m00']
    angs = np.arange(0, 360, 10); rs = []
    for a in angs:
        th = np.radians(a); dx = np.cos(th); dy = np.sin(th); r = 0
        for t in range(1, 130):
            x = int(round(cx + dx * t)); y = int(round(cy + dy * t))
            if x < 0 or y < 0 or x >= crop.shape[1] or y >= crop.shape[0]: break
            if m[y, x] > 0: r = t
        rs.append(r)
    rs = np.array(rs, float); pos = rs[rs > 5]
    if len(pos) == 0: return None
    return np.radians(angs), rs / float(np.median(pos))

def wing_energy(crop):
    o = radial(crop)
    if o is None: return 0.0
    a, rn = o; lat = np.abs(np.cos(a)) ** 6; w = np.maximum(0, rn - 1.0)
    return float((w * lat).sum())

def limb_energy(crop):
    o = radial(crop)
    if o is None: return 0.0
    a, rn = o; lat = np.abs(np.cos(a)) ** 2; bot = np.maximum(0, np.sin(a)) ** 2
    w = np.maximum(0, rn - 1.0)
    return float((w * (lat + bot)).sum())

def stripe_score(crop):
    g = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3); gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    mag = cv2.magnitude(gx, gy); ang = np.degrees(np.arctan2(gy, gx)) % 180
    t = torso_mask(crop)
    if t is None or t.sum() < 30: return 0.0
    thr = np.percentile(mag[t > 0], 75)
    sel = (mag > thr) & (t > 0)
    if sel.sum() < 10: return 0.0
    h, _ = np.histogram(ang[sel], bins=18, range=(0, 180))
    h = h.astype(float); h /= (h.sum() + 1e-6)
    return float(h.max() - h.mean())

def eye_count(crop):
    t = torso_mask(crop)
    if t is None: return 0.0
    ys, xs = np.where(t > 0)
    if len(xs) < 20: return 0.0
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    white = ((hsv[:, :, 2] > 140) & (hsv[:, :, 1] < 95)).astype(np.uint8)
    n, lab, st, ct = cv2.connectedComponentsWithStats(white)
    cnt = 0
    for i in range(1, n):
        a = st[i, 4]
        if a < 12 or a > 500: continue
        cx, cy = ct[i]
        if not (x0 - 4 <= cx <= x1 + 4 and y0 - 4 <= cy <= y1 + 4): continue
        if cy > (y0 + y1) / 2 + 3: continue
        w = st[i, 2]; h = st[i, 3]
        if 0.35 < w / (h + 1e-6) < 2.8: cnt += 1
    return cnt

def eye_score(crop):
    return -abs(eye_count(crop) - 2)

def eye_centers(crop):
    t = torso_mask(crop)
    if t is None: return []
    ys, xs = np.where(t > 0)
    if len(xs) < 20: return []
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    white = ((hsv[:, :, 2] > 140) & (hsv[:, :, 1] < 95)).astype(np.uint8)
    n, lab, st, ct = cv2.connectedComponentsWithStats(white)
    out = []
    for i in range(1, n):
        a = st[i, 4]
        if a < 12 or a > 500: continue
        cx, cy = ct[i]
        if not (x0 - 4 <= cx <= x1 + 4 and y0 - 4 <= cy <= y1 + 4): continue
        if cy > (y0 + y1) / 2 + 3: continue
        w = st[i, 2]; h = st[i, 3]
        if 0.35 < w / (h + 1e-6) < 2.8: out.append((float(cx), float(cy)))
    return out

def blob_orient_score(crop):
    t = torso_mask(crop)
    if t is None: return 0.0
    ys, xs = np.where(t > 0)
    if len(xs) < 20: return 0.0
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    dark = ((hsv[:, :, 2] < 115) & (t > 0)).astype(np.uint8)
    n, lab, st, ct = cv2.connectedComponentsWithStats(dark)
    best = 0.0
    for i in range(1, n):
        a = st[i, 4]
        if a < 10 or a > 200: continue
        cx, cy = ct[i]
        if cy > (y0 + y1) / 2 + 5: continue
        yy, xx = np.where(lab == i)
        if len(xx) < 10: continue
        p = np.stack([xx, yy], 1).astype(np.float32)
        _, eig, _ = cv2.PCACompute2(p, mean=None)
        ang = float(np.degrees(np.arctan2(eig[0, 1], eig[0, 0]))) % 180
        score = float(min(ang, 180 - ang))
        if score > best: best = score
    return best

def eyeline_score(crop):
    pts = eye_centers(crop)
    if len(pts) < 2: return 0.0
    p = np.array(pts, np.float32)
    _, eig, _ = cv2.PCACompute2(p, mean=None)
    ang = float(np.degrees(np.arctan2(eig[0, 1], eig[0, 0]))) % 180
    return float(min(ang, 180 - ang))

def torso_angle(crop):
    t = torso_mask(crop)
    if t is None: return 90.0
    ys, xs = np.where(t > 0)
    if len(xs) < 10: return 90.0
    pts = np.stack([xs, ys], 1).astype(np.float32)
    _, eig, _ = cv2.PCACompute2(pts, mean=None)
    return float(np.degrees(np.arctan2(eig[0, 1], eig[0, 0]))) % 180

def armleg_score(crop):
    o = radial(crop)
    if o is None: return 0.0
    a, rn = o; w = np.maximum(0, rn - 1.1)
    lat = float((w * np.abs(np.cos(a)) ** 6).sum())
    bot = float((w * np.maximum(0, np.sin(a)) ** 2).sum())
    return float(min(lat, bot))

def pupil_count(crop):
    m, st = largest_comp(fgmask(crop))
    if m is None: return 0
    ys, xs = np.where(m > 0)
    if len(xs) < 20: return 0
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    dark = ((hsv[:, :, 2] < 115) & (m > 0)).astype(np.uint8)
    face = np.zeros_like(dark)
    h = y1 - y0; wd = x1 - x0
    ya = int(y0 + 0.22 * h); yb = int(y0 + 0.58 * h)
    xa = int(x0 + 0.18 * wd); xb = int(x0 + 0.82 * wd)
    face[ya:yb, xa:xb] = 1
    dark = dark * face
    n, lab, st2, ct = cv2.connectedComponentsWithStats(dark)
    cnt = 0
    for i in range(1, n):
        a = st2[i, 4]; w = st2[i, 2]; hh = st2[i, 3]
        if a < 3 or a > 100: continue
        if not (0.4 < w / (hh + 1e-6) < 2.5): continue
        mm = (lab == i).astype(np.uint8)
        cs2, _ = cv2.findContours(mm, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cs2: continue
        peri = cv2.arcLength(cs2[0], True)
        circ = 4 * np.pi * a / (peri * peri + 1e-6)
        if circ > 0.45: cnt += 1
    return cnt

def pupil_score(crop):
    return -abs(pupil_count(crop) - 2)

# ---- models ----
dino = timm.create_model('vit_small_patch14_dinov2.lvd142m', pretrained=True, num_classes=0, img_size=518); dino.eval()
dtf = T.Compose([T.Resize((518, 518)), T.ToTensor(), T.Normalize((0.485, 0.456, 0.406), (0.229, 0.224, 0.225))])
d224 = timm.create_model('vit_small_patch14_dinov2.lvd142m', pretrained=True, num_classes=0, img_size=224); d224.eval()
dtf2 = T.Compose([T.Resize((224, 224)), T.ToTensor(), T.Normalize((0.485, 0.456, 0.406), (0.229, 0.224, 0.225))])
clip, _, ctf = open_clip.create_model_and_transforms('ViT-B-32', pretrained='openai')
ctok = open_clip.get_tokenizer('ViT-B-32'); clip.eval()
PROMPTS = {
    'upside': ("an upside-down cartoon monster with its feet up", "an upright cartoon monster"),
    'different_body': ("a cartoon monster with a round body", "a cartoon monster with a square body"),
    'diff_body': ("a cartoon monster with a round body", "a cartoon monster with a square body"),
    'no_wings': ("a cartoon monster with no wings", "a cartoon monster with large wings"),
    'wings': ("a cartoon monster with large wings", "a cartoon monster with no wings"),
    'eyes': ("a cartoon monster with two eyes", "a cartoon monster with one eye"),
    'stripes': ("a cartoon monster with stripes on its body", "a cartoon monster with a plain body"),
    'arms_legs': ("a cartoon monster with arms and legs", "a cartoon monster with wings only"),
}
TEXT = {}
for k, (p, n) in PROMPTS.items():
    with torch.no_grad():
        t = clip.encode_text(ctok([p, n])); TEXT[k] = t / t.norm(dim=-1, keepdim=True)

def dino_tokens(model, tf, imgs, mask=True):
    x = torch.stack([tf(Image.fromarray(cv2.cvtColor(im, cv2.COLOR_BGR2RGB))) for im in imgs])
    with torch.no_grad():
        f = model.forward_features(x)
    pat = f[:, model.num_prefix_tokens:]
    pat = pat / pat.norm(dim=-1, keepdim=True)
    idxs = []
    gg = int(round(x.shape[-1] / 14))
    for im in imgs:
        mm = cv2.resize(fgmask(im), (gg, gg), interpolation=cv2.INTER_AREA)
        idx = np.where(mm.reshape(-1) > 0.3)[0]
        if not mask or len(idx) < 20: idx = np.arange(gg * gg)
        idxs.append(torch.from_numpy(idx).long())
    return pat, idxs

def dino_scores(cs, rf):
    pat, idxs = dino_tokens(dino, dtf, cs + [rf])
    rp = pat[8]; ri = idxs[8]
    B = torch.zeros(8, len(ri))
    for i in range(8):
        B[i] = (rp[ri] @ pat[i][idxs[i]].T).max(1).values
    p20 = torch.quantile(B, 0.2, dim=1).numpy()
    prev = B.mean(0); k = max(1, int(0.25 * len(ri)))
    sel = torch.argsort(prev)[:k]
    tfidf = B[:, sel].mean(1).numpy()
    p2, _ = dino_tokens(d224, dtf2, cs + [rf], mask=False)
    B2 = torch.stack([(p2[8] @ p2[i].T).max(1).values for i in range(8)])
    p20b = torch.quantile(B2, 0.2, dim=1).numpy()
    return {'p20': p20, 'tfidf': tfidf, 'p20_224': p20b}

def clip_score(cs, key):
    x = torch.stack([ctf(Image.fromarray(cv2.cvtColor(im, cv2.COLOR_BGR2RGB))) for im in cs])
    with torch.no_grad():
        e = clip.encode_image(x); e = e / e.norm(dim=-1, keepdim=True)
    t = TEXT[key]
    return (e @ t[0] - e @ t[1]).numpy()



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


ROUTE = {
    'twins': 'p20_hi', 'wings': 'p20_hi', 'missing': 'p20_224_hi', 'extra': 'p20_hi',
    'no_wings': 'p20_lo', 'arms_legs': 'armleg_hi', 'eyes': 'eyes_fused_hi',
    'stripes': 'stripe_hi', 'upside': 'clip_hi', 'lying': 'p20_hi',
    'biggest_smallest': 'area_ext', 'biggest': 'area_ext', 'smallest': 'area_ext',
    'different_body': 'stripe_lo',
}


def solve(img, ref, prompt):
    task, n = parse_task(prompt)
    H, W = img.shape[:2]
    cs = cells(img)
    S = {}
    S.update(dino_scores(cs, ref))
    if task in PROMPTS:
        S['clip'] = clip_score(cs, task)
    S['area'] = np.array([area_of(c) for c in cs], float)
    S['angle'] = np.array([abs(angle_of(c) - 90) for c in cs], float)
    S['wing'] = np.array([wing_energy(c) for c in cs])
    S['limb'] = np.array([limb_energy(c) for c in cs])
    S['stripe'] = np.array([stripe_score(c) for c in cs])
    S['eyes'] = np.array([eye_score(c) for c in cs])
    S['armleg'] = np.array([armleg_score(c) for c in cs])
    S['torso'] = np.array([int(np.sum(torso_mask(c) > 0)) for c in cs], float)
    S['tangle'] = np.array([torso_angle(c) for c in cs], float)
    S['rot'] = np.abs(S['tangle'] - np.median(S['tangle']))
    S['eyeline'] = np.array([eyeline_score(c) for c in cs], float)
    S['blobori'] = np.array([blob_orient_score(c) for c in cs], float)
    S['pupil'] = np.array([pupil_score(c) for c in cs])
    D = np.stack([body_desc(c) for c in cs])
    med = np.median(D, 0); mad = np.median(np.abs(D - med), 0) + 1e-3
    S['body_out'] = np.linalg.norm((D - med) / mad, axis=1)
    S['body_circ'] = D[:, 2]; S['body_corners'] = D[:, 4]; S['body_aspect'] = D[:, 0]

    def rk(v):
        r = np.empty(len(v), int); r[np.argsort(-v)] = np.arange(len(v)); return r
    S['eyes_fused'] = -(rk(S['p20']) + rk(S['stripe']) + rk(S['eyes']))

    cand = {}
    for k, v in S.items():
        cand[k + '_hi'] = set(np.argsort(-v)[:2].tolist())
        cand[k + '_lo'] = set(np.argsort(v)[:2].tolist())
    a = S['area']; cand['area_ext'] = {int(a.argmax()), int(a.argmin())}
    tr = S['torso']; cand['torso_ext'] = {int(tr.argmax()), int(tr.argmin())}

    m = ROUTE.get(task, 'p20_hi')
    idx = sorted(cand[m])
    pts = [[int((i % 4 + 0.5) * 450 / 4), int((i // 4 + 0.5) * 280 / 2)] for i in idx]
    return {
        'ok': len(pts) > 0, 'task': task, 'want': n, 'w': W, 'h': H,
        'found': len(cs), 'method': m, 'points': pts,
        'answer': ';'.join(f'{x},{y}' for x, y in pts),
    }


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
