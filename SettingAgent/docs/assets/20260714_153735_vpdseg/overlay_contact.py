"""VPD seg 마스크의 하단 윤곽(=접지선 후보)을 실제 프레임에 오버레이해 육안 검증한다.
비교 대상: (A) 현재 방식 = bbox 하단변 중점  vs  (B) 제안 = 마스크 하단 윤곽.
레포에 아무것도 쓰지 않는다(스크래치패드 전용).
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np

SP = Path(sys.argv[1])
REPO = Path(sys.argv[2])
CONF_MIN = 0.50  # setup.minConfidence 와 동일 — V-1 거대 노이즈 박스 배제

for tag in ("p1", "p2", "p3"):
    img = cv2.imread(str(REPO / "SettingAgent/data/refframes" / f"cam1_{tag}.jpg"))
    H, W = img.shape[:2]
    d = json.loads((SP / f"seg_{tag}.json").read_text(encoding="utf-8"))
    masks, bboxes, confs = d["masks"], d["bboxes"], d["confidences"]

    kept = 0
    for poly_pts, box, conf in zip(masks, bboxes, confs):
        if conf < CONF_MIN or len(poly_pts) < 3:
            continue
        kept += 1
        poly = np.array(poly_pts, dtype=np.int32)
        x1, y1, x2, y2 = [int(v) for v in box]

        # (A) 현재 방식: bbox + 하단변 중점.
        cv2.rectangle(img, (x1, y1), (x2, y2), (0, 200, 255), 2)          # 노랑 bbox
        cv2.circle(img, ((x1 + x2) // 2, y2), 9, (255, 0, 255), -1)        # 마젠타 = bbox 하단중점

        # 마스크 외곽선(청록, 얇게).
        cv2.polylines(img, [poly], True, (255, 255, 0), 1)

        # (B) 제안: 마스크 하단 윤곽 = 열(column)마다 마스크의 최하단 픽셀.
        m = np.zeros((H, W), np.uint8)
        cv2.fillPoly(m, [poly], 255)
        cols = np.where(m.any(axis=0))[0]
        lower = [(int(c), int(np.where(m[:, c])[0].max())) for c in cols]
        if len(lower) >= 2:
            cv2.polylines(img, [np.array(lower, np.int32)], False, (0, 0, 255), 3)  # 빨강 = 접지선

        # 마스크 최하단 점(가장 확실한 단일 접지점) = 초록.
        lp = max(lower, key=lambda p: p[1])
        cv2.circle(img, lp, 7, (0, 255, 0), -1)
        cv2.putText(img, f"{conf:.2f}", (x1, max(y1 - 6, 12)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 200, 255), 2)

    legend = [
        ("yellow bbox + magenta dot = CURRENT (bbox bottom-center)", (255, 0, 255)),
        ("red curve = PROPOSED (mask lower boundary = ground contact)", (0, 0, 255)),
        ("green dot = lowest mask pixel", (0, 255, 0)),
    ]
    for i, (txt, col) in enumerate(legend):
        cv2.putText(img, txt, (14, 30 + i * 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 4)
        cv2.putText(img, txt, (14, 30 + i * 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, col, 2)

    out = SP / f"contact_{tag}.jpg"
    cv2.imwrite(str(out), img)
    print(f"{tag}: {W}x{H}  conf>={CONF_MIN} 유지 {kept}/{len(masks)}대  -> {out.name}")
