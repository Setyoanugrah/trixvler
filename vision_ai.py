import sys, json, base64, urllib.request, re, time

NUMES_URL = "https://api.numes.ai/api/v1/chat/completions"
NUMES_KEY = "sk-numes-v1-058f17f5e6b41a0e8c684318ec20d2ca1d9aa7158badedc10a45af47c6eae86a"
MODELS = ["z-ai/glm-5.3-flash:free", "z-ai/glm-5.1-flash:free"]

def call(image_b64, ref_b64, prompt):
    content = [{"type": "text", "text": (
        "Visual CAPTCHA. TWO images: 1) SCENE (450x280) with cartoon monsters. "
        "2) REFERENCE showing which monster(s) to tap.\n"
        "Instruction: " + prompt + "\n\n"
        "Examine the REFERENCE, find matching monster(s) in SCENE. "
        "Reply ONLY JSON array of [x,y] centers (0-450,0-280), e.g. [[120,80],[300,210]]. No other text."
    )}]
    for b in (image_b64, ref_b64):
        if b:
            content.append({"type":"image_url","image_url":{"url":"data:image/png;base64,"+b}})
    last=None
    for attempt in range(6):
        model=MODELS[attempt % len(MODELS)]
        body={"model":model,"temperature":0,"max_tokens":200,
              "messages":[{"role":"user","content":content}]}
        try:
            req=urllib.request.Request(NUMES_URL,data=json.dumps(body).encode(),
                headers={"Authorization":"Bearer "+NUMES_KEY,"Content-Type":"application/json"},method="POST")
            r=urllib.request.urlopen(req,timeout=120)
            j=json.loads(r.read().decode())
            c=j.get("choices",[{}])[0].get("message",{}).get("content","")
            if isinstance(c,list): c="".join(p.get("text","") if isinstance(p,dict) else str(p) for p in c)
            return str(c).strip()
        except Exception as e:
            last=e
            time.sleep(2)
    raise last

def parse(text):
    pts=[]
    for a,b in re.findall(r"(\d{1,3})\s*[,:]\s*(\d{1,3})",text or ""):
        x,y=int(a),int(b)
        if 0<=x<=450 and 0<=y<=280: pts.append((x,y))
    return pts

if __name__=="__main__":
    d=json.loads(sys.stdin.read())
    try:
        out=call(d.get("image",""),d.get("ref",""),d.get("prompt",""))
        pts=parse(out)
        print(json.dumps({"ok":bool(pts),"raw":out[:200],"points":pts,
                          "answer":";".join(f"{x},{y}" for x,y in pts)}))
    except Exception as e:
        print(json.dumps({"ok":False,"error":str(e)[:200]}))
