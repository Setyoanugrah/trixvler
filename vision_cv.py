import sys, json, base64, re
import cv2
import numpy as np

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

def ink_size(crop):
    """Sprite scale without counting the pale confetti and guide lines."""
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    return int(((hsv[:, :, 1] > 100) & (hsv[:, :, 2] < 160)).sum())

def hue_bbox_size(crop):
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    hue, saturation, value = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    height, width = hue.shape
    best_score = -1.0
    best_area = 0
    for bucket in range(24):
        low = bucket * 180 / 24
        high = (bucket + 1) * 180 / 24
        mask = (
            (hue >= low) & (hue < high)
            & (saturation > 70) & (value > 45)
        ).astype(np.uint8)
        count, _, stats, centroids = cv2.connectedComponentsWithStats(mask)
        for i in range(1, count):
            x, y, w, h, area = stats[i]
            if x <= 2 or y <= 2 or x + w >= width - 2 or y + h >= height - 2:
                continue
            if area <= 30:
                continue
            dx = (centroids[i, 0] - width / 2) / width
            dy = (centroids[i, 1] - height / 2) / height
            score = area / (1 + 100 * (dx * dx + dy * dy))
            if score > best_score:
                best_score = score
                best_area = int(w * h)
    return best_area

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
    if t is None: return 0
    ys, xs = np.where(t > 0)
    if len(xs) < 20: return 0
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    body_w = x1 - x0
    body_h = y1 - y0
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    white = ((hsv[:, :, 2] > 140) & (hsv[:, :, 1] < 95)).astype(np.uint8)
    n, _, st, ct = cv2.connectedComponentsWithStats(white)
    candidates = []
    for i in range(1, n):
        a = st[i, 4]
        if a < 15 or a > 500: continue
        cx, cy = ct[i]
        w = st[i, 2]; h = st[i, 3]
        ratio = w / (h + 1e-6)
        if not (0.55 < ratio < 1.7): continue
        if not (x0 - 0.3 * body_w <= cx <= x1 + 0.3 * body_w): continue
        if not (y0 - max(25, 0.9 * body_h) <= cy <= y0 + 0.4 * body_h): continue
        candidates.append((float(cy), int(a)))
    candidates.sort()
    rows = []
    for candidate in candidates:
        if not rows or candidate[0] - rows[-1][-1][0] > 8.2:
            rows.append([candidate])
        else:
            rows[-1].append(candidate)
    if not rows:
        return 0
    best = max(rows, key=lambda row: (sum(area for _, area in row), -row[0][0]))
    return len(best)

def eye_score(crop, target=2):
    return -abs(eye_count(crop) - target)

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

# ---- local model (loaded only for reference-dependent tasks) ----
_DINO = {}
_CLIP = None

def dino_model(size):
    if size in _DINO:
        return _DINO[size]
    import torch
    import timm
    from PIL import Image
    import torchvision.transforms as transforms
    model = timm.create_model(
        'vit_small_patch14_dinov2.lvd142m', pretrained=True,
        num_classes=0, img_size=size)
    model.eval()
    tf = transforms.Compose([
        transforms.Resize((size, size)), transforms.ToTensor(),
        transforms.Normalize((0.485, 0.456, 0.406),
                             (0.229, 0.224, 0.225)),
    ])
    _DINO[size] = (torch, Image, model, tf)
    return _DINO[size]

def dino_similarity(cs, ref, size=224):
    if ref is None:
        raise ValueError('missing-ref')
    torch, Image, model, tf = dino_model(size)
    imgs = cs + [ref]
    x = torch.stack([
        tf(Image.fromarray(cv2.cvtColor(im, cv2.COLOR_BGR2RGB)))
        for im in imgs
    ])
    with torch.no_grad():
        f = model.forward_features(x)
    pat = f[:, model.num_prefix_tokens:]
    pat = pat / pat.norm(dim=-1, keepdim=True)
    grid = int(round(size / 14))
    idxs = []
    for im in imgs:
        mm = cv2.resize(fgmask(im), (grid, grid), interpolation=cv2.INTER_AREA)
        idx = np.where(mm.reshape(-1) > 0.3)[0]
        if size <= 224 or len(idx) < 20:
            idx = np.arange(grid * grid)
        idxs.append(torch.from_numpy(idx).long())
    ref_patches = pat[8][idxs[8]]
    scores = []
    for i in range(8):
        matches = ref_patches @ pat[i][idxs[i]].T
        scores.append(float(torch.quantile(matches.max(1).values, 0.2)))
    return np.asarray(scores, dtype=float)

def clip_similarity(cs, positive, negative):
    global _CLIP
    if _CLIP is None:
        import torch
        import open_clip
        from PIL import Image
        model, _, transform = open_clip.create_model_and_transforms(
            'ViT-B-32', pretrained='openai')
        model.eval()
        tokenizer = open_clip.get_tokenizer('ViT-B-32')
        _CLIP = (torch, Image, model, transform, tokenizer, {})
    torch, Image, model, transform, tokenizer, text_cache = _CLIP
    key = (positive, negative)
    if key not in text_cache:
        with torch.no_grad():
            text = model.encode_text(tokenizer([positive, negative]))
            text_cache[key] = text / text.norm(dim=-1, keepdim=True)
    images = torch.stack([
        transform(Image.fromarray(cv2.cvtColor(im, cv2.COLOR_BGR2RGB)))
        for im in cs
    ])
    with torch.no_grad():
        encoded = model.encode_image(images)
        encoded = encoded / encoded.norm(dim=-1, keepdim=True)
    text = text_cache[key]
    return (encoded @ text[0] - encoded @ text[1]).numpy()



def decode(b64):
    if not b64:
        return None
    b64 = re.sub(r'^data:image/\w+;base64,', '', b64)
    raw = base64.b64decode(b64)
    return cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)


def parse_task_spec(prompt):
    t = re.sub(r'\s+', ' ', (prompt or '').lower()).strip()
    m = re.search(r'\btap(?:\s+(?:its|the))?\s+(\d+)\b', t)
    if not m:
        m = re.search(r'\b(\d+)\b', t)
    count = int(m.group(1)) if m else 2
    eye = re.search(r'\bwith\s+(\d+)\s+eyes?\b', t)
    target_eye_count = int(eye.group(1)) if eye else None
    parts = tuple(p for p in ('arms', 'legs', 'wings') if p in t)

    if 'twin' in t or 'identical' in t or 'same parts' in t:
        task = 'twins'
    elif 'missing' in t:
        task = 'missing'
    elif 'extra part' in t or 'part added' in t:
        task = 'extra'
    elif 'no wing' in t or 'without wing' in t:
        task = 'no_wings'
    elif 'same wing' in t:
        task = 'same_wings'
    elif len(parts) >= 2:
        task = 'parts'
    elif 'eye' in t:
        task = 'eyes'
    elif 'stripe' in t:
        task = 'stripes'
    elif 'upside' in t or 'on their head' in t or 'on its head' in t:
        task = 'upside'
    elif 'lying' in t or 'on their side' in t or 'on its side' in t:
        task = 'lying'
    elif ('biggest' in t or 'largest' in t) and ('smallest' in t or 'tiniest' in t):
        task, count = 'biggest_smallest', 2
    elif 'biggest' in t or 'largest' in t:
        task = 'biggest'
    elif 'smallest' in t or 'tiniest' in t:
        task = 'smallest'
    elif 'different body' in t:
        task = 'different_body'
    else:
        task = 'unknown'
    return {
        'task': task, 'count': max(1, min(count, 8)),
        'eye_count': target_eye_count, 'parts': parts,
    }


def parse_task(prompt):
    spec = parse_task_spec(prompt)
    return spec['task'], spec['count']


def ranked(scores, count, high=True):
    scores = np.asarray(scores, dtype=float)
    if len(scores) < count or not np.all(np.isfinite(scores)):
        return [], 0.0
    order = np.argsort(-scores if high else scores, kind='stable')
    picked = order[:count].tolist()
    if count >= len(scores):
        return sorted(picked), 0.0
    boundary = scores[order[count - 1]] - scores[order[count]]
    if not high:
        boundary = -boundary
    confidence = max(0.0, float(boundary) / (float(np.ptp(scores)) + 1e-6))
    return sorted(picked), min(confidence, 1.0)


def extremes(scores):
    scores = np.asarray(scores, dtype=float)
    lo = int(np.argmin(scores)); hi = int(np.argmax(scores))
    if lo == hi:
        return [], 0.0
    ordered = np.sort(scores)
    span = float(np.ptp(scores)) + 1e-6
    confidence = min(float(ordered[1] - ordered[0]),
                     float(ordered[-1] - ordered[-2])) / span
    return sorted([lo, hi]), max(0.0, min(confidence, 1.0))


def different_body_pair(cs):
    desc = np.stack([body_desc(c) for c in cs]).astype(float)
    # Size is intentionally omitted: this task is only about torso shape.
    features = desc[:, :5]
    med = np.median(features, axis=0)
    mad = np.median(np.abs(features - med), axis=0)
    z = (features - med) / np.maximum(mad, 0.05)
    candidates = []
    for i in range(len(z)):
        for j in range(i + 1, len(z)):
            rest = np.delete(z, (i, j), axis=0)
            pair_center = (z[i] + z[j]) / 2
            rest_center = rest.mean(axis=0)
            separation = np.linalg.norm(pair_center - rest_center)
            within = np.linalg.norm(z[i] - z[j])
            rest_spread = np.mean(np.linalg.norm(rest - rest_center, axis=1))
            candidates.append((separation - 1.25 * within - 0.15 * rest_spread, i, j))
    candidates.sort(reverse=True)
    best = candidates[0]
    span = abs(best[0]) + 1e-6
    confidence = max(0.0, min((best[0] - candidates[1][0]) / span, 1.0))
    return sorted([best[1], best[2]]), confidence


REFERENCE_TASKS = {
    'twins': (518, True),
    'same_wings': (518, True),
    'missing': (224, True),
    'extra': (518, True),
    'no_wings': (518, False),
    'lying': (518, True),
}


def solve(img, ref, prompt):
    spec = parse_task_spec(prompt)
    task, count = spec['task'], spec['count']
    if img is None:
        return {'ok': False, 'task': task, 'error': 'no-image'}
    height, width = img.shape[:2]
    if (width, height) != (W, H):
        return {
            'ok': False, 'task': task, 'error': 'bad-image-size',
            'expected': [W, H], 'actual': [width, height],
        }
    if task == 'unknown':
        return {'ok': False, 'task': task, 'error': 'unknown-task'}

    cs = cells(img)
    method = ''
    confidence = 0.0
    if task == 'parts':
        required = set(spec['parts'])
        if required == {'arms', 'legs'}:
            scores = np.asarray([armleg_score(c) for c in cs], dtype=float)
            idx, confidence = ranked(scores, count, high=True)
            method = 'armleg_cv'
        else:
            if ref is None:
                return {'ok': False, 'task': task, 'error': 'missing-ref'}
            scores = dino_similarity(cs, ref, size=518)
            idx, confidence = ranked(scores, count, high=True)
            method = 'dino518_fallback'
    elif task == 'eyes':
        target = spec['eye_count'] or 2
        scores = np.asarray([eye_score(c, target) for c in cs], dtype=float)
        idx, confidence = ranked(scores, count, high=True)
        method = 'eye_count_cv'
    elif task == 'upside':
        scores = clip_similarity(
            cs,
            'an upside-down cartoon monster with its feet up',
            'an upright cartoon monster',
        )
        idx, confidence = ranked(scores, count, high=True)
        method = 'clip_fallback'
    elif task in REFERENCE_TASKS:
        if ref is None:
            return {'ok': False, 'task': task, 'error': 'missing-ref'}
        size, high = REFERENCE_TASKS[task]
        scores = dino_similarity(cs, ref, size=size)
        idx, confidence = ranked(scores, count, high=high)
        method = f'dino{size}_{"hi" if high else "lo"}'
    elif task in ('biggest_smallest', 'biggest', 'smallest'):
        scores = np.asarray([hue_bbox_size(c) for c in cs], dtype=float)
        if task == 'biggest_smallest':
            idx, confidence = extremes(scores)
            method = 'hue_bbox_extremes'
        else:
            idx, confidence = ranked(scores, count, high=(task == 'biggest'))
            method = 'hue_bbox_size'
    elif task == 'stripes':
        scores = np.asarray([stripe_score(c) for c in cs], dtype=float)
        idx, confidence = ranked(scores, count, high=True)
        method = 'stripe_cv'
    elif task == 'different_body':
        idx, confidence = different_body_pair(cs)
        method = 'body_cluster_cv'
        if confidence < 0.5:
            scores = clip_similarity(
                cs,
                'a cartoon monster with a round body',
                'a cartoon monster with a square body',
            )
            idx, confidence = ranked(scores, count, high=True)
            method = 'clip_fallback'
    else:
        return {'ok': False, 'task': task, 'error': 'unsupported-task'}

    points = [[CENTERS[i][0], CENTERS[i][1]] for i in idx]
    ok = len(points) == count
    return {
        'ok': ok, 'task': task, 'want': count, 'w': width, 'h': height,
        'found': sum(area_of(c) > 50 for c in cs), 'method': method,
        'indices': idx, 'points': points,
        'answer': ';'.join(f'{x},{y}' for x, y in points),
        'confidence': round(float(confidence), 4),
        'ambiguous': confidence < 0.04,
    }


def handle(data):
    try:
        return solve(
            decode(data.get('image', '')),
            decode(data.get('ref', '')),
            data.get('prompt', ''),
        )
    except Exception as exc:
        return {'ok': False, 'error': str(exc)[:200]}


def main():
    if '--worker' in sys.argv:
        for line in sys.stdin:
            try:
                data = json.loads(line)
                request_id = data.pop('_id', None)
                out = handle(data)
                if request_id is not None:
                    out['_id'] = request_id
            except Exception as exc:
                out = {'ok': False, 'error': str(exc)[:200]}
            print(json.dumps(out), flush=True)
        return
    raw = sys.stdin.read()
    print(json.dumps(handle(json.loads(raw))))


if __name__ == '__main__':
    main()
