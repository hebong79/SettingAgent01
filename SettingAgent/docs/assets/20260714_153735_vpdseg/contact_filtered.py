"""가설 검증: 주차면 필터(모드 A)가 살리는 근경 차량 = 미가림 차량인가?

각 차량의 마스크 하단 윤곽 점을 '유효 접지점'과 '가림 구간'으로 분류한다.
  가림 판정 = 하단 윤곽점 바로 아래(+6px)가 '다른 차량'의 마스크 안 → 그 열은 접지선이 아님.
빨강 = 유효 접지점 / 회색 = 가림으로 버려진 구간.
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np

SP, REPO = Path(sys.argv[1]), Path(sys.argv[2])
CONF_MIN, OVERLAP_MIN, BELOW = 0.50, 0.15, 6

roi = json.loads((REPO / "SettingAgent/data/Place01/PtzCamRoi.json").read_text(encoding="utf-8"))
presets = {p["preset_idx"]: p["parking_spaces"] for p in roi["cameras"][0]["presets"]}

for idx, tag in ((1, "p1"), (2, "p2"), (3, "p3")):
    img = cv2.imread(str(REPO / "SettingAgent/data/refframes" / f"cam1_{tag}.jpg"))
    H, W = img.shape[:2]
    d = json.loads((SP / f"seg_{tag}.json").read_text(encoding="utf-8"))

    slot_m = np.zeros((H, W), np.uint8)
    for sp in presets[idx]:
        cv2.fillPoly(slot_m, [np.array(sp["points"], np.int32)], 255)
        cv2.polylines(img, [np.array(sp["points"], np.int32)], True, (0, 255, 255), 2)

    # 1) conf 하한 + 주차면 겹침비 >= 0.15 (= 모드 A 필터)로 유지 차량 선별.
    cand = []
    for pts, box, conf in zip(d["masks"], d["bboxes"], d["confidences"]):
        if conf < CONF_MIN or len(pts) < 3:
            continue
        m = np.zeros((H, W), np.uint8)
        cv2.fillPoly(m, [np.array(pts, np.int32)], 255)
        a = int((m > 0).sum())
        ov = int(((m > 0) & (slot_m > 0)).sum()) / a if a else 0.0
        cand.append({"m": m, "box": box, "conf": conf, "ov": ov})

    kept = [c for c in cand if c["ov"] >= OVERLAP_MIN]
    other = [np.zeros((H, W), np.uint8)] if not kept else None

    # 2) 유지 차량마다 하단 윤곽을 유효/가림으로 분류.
    stats = []
    for i, c in enumerate(kept):
        m = c["m"]
        others = np.zeros((H, W), np.uint8)
        for j, o in enumerate(cand):          # 가림은 '모든' 검출(버려진 것 포함) 기준으로 판단
            if o is not c:
                others |= o["m"]
        good, bad = [], []
        for x in np.where(m.any(axis=0))[0]:
            y = int(np.where(m[:, x])[0].max())
            yb = min(y + BELOW, H - 1)
            (bad if others[yb, int(x)] > 0 else good).append((int(x), y))
        for seg, col, th in ((bad, (150, 150, 150), 2), (good, (0, 0, 255), 4)):
            if len(seg) >= 2:
                cv2.polylines(img, [np.array(seg, np.int32)], False, col, th)
        x1, y1, x2, y2 = [int(v) for v in c["box"]]
        cv2.rectangle(img, (x1, y1), (x2, y2), (0, 200, 255), 2)
        cv2.circle(img, ((x1 + x2) // 2, y2), 9, (255, 0, 255), -1)
        r = len(good) / max(len(good) + len(bad), 1)
        stats.append(r)
        cv2.putText(img, f"{c['conf']:.2f} ov{c['ov']:.2f} clean{r:.0%}", (x1, max(y1 - 8, 14)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 4)
        cv2.putText(img, f"{c['conf']:.2f} ov{c['ov']:.2f} clean{r:.0%}", (x1, max(y1 - 8, 14)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 0), 1)

    for i, (t, col) in enumerate([
        ("cyan = parking slots (this preset)", (0, 255, 255)),
        ("RED = valid ground-contact columns", (0, 0, 255)),
        ("GRAY = rejected (occluded from below)", (150, 150, 150)),
        ("magenta = bbox bottom-center (current)", (255, 0, 255)),
    ]):
        cv2.putText(img, t, (14, 30 + i * 28), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0, 0, 0), 4)
        cv2.putText(img, t, (14, 30 + i * 28), cv2.FONT_HERSHEY_SIMPLEX, 0.65, col, 2)

    cv2.imwrite(str(SP / f"filt_{tag}.jpg"), img)
    cl = "  ".join(f"{s:.0%}" for s in stats)
    print(f"{tag}: 검출 {len(d['masks'])} -> conf>={CONF_MIN} {len(cand)} -> 주차면위 {len(kept)}대 | 접지선 유효비율: {cl}")
