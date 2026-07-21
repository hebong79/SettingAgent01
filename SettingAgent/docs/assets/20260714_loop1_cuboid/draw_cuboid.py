"""G3 육안 검증: 산출된 3D 육면체 + 슬롯 ROI 를 실제 프레임에 렌더."""
import json, sys
from pathlib import Path
import cv2, numpy as np

SP, REPO = Path(sys.argv[1]), Path(sys.argv[2])
ov = json.loads((REPO / "_leader_overlay.json").read_text(encoding="utf-8"))
roi = json.loads((REPO / "SettingAgent/data/Place01/PtzCamRoi.json").read_text(encoding="utf-8"))
presets = {p["preset_idx"]: p["parking_spaces"] for p in roi["cameras"][0]["presets"]}

# 육면체 12간선: 바닥 0-1-2-3(FL,FR,RR,RL) / 지붕 4-5-6-7 / 수직 i-(i+4)
EDGES = [(0,1),(1,2),(2,3),(3,0), (4,5),(5,6),(6,7),(7,4), (0,4),(1,5),(2,6),(3,7)]

for idx, tag in ((1,"p1"), (2,"p2"), (3,"p3")):
    img = cv2.imread(str(REPO / "SettingAgent/data/refframes" / f"cam1_{tag}.jpg"))

    # 슬롯 ROI (노랑) — 도색된 주차선과 맞는지 함께 본다
    for sp in presets[idx]:
        cv2.polylines(img, [np.array(sp["points"], np.int32)], True, (0, 220, 220), 2)

    for c in ov.get(tag, []):
        p = c["px"]
        x1, y1, x2, y2 = [int(v) for v in c["vpd"]]
        cv2.rectangle(img, (x1, y1), (x2, y2), (160, 160, 160), 1)          # VPD bbox (회색)
        # 바닥면 채우기(반투명 빨강) = 접지 footprint
        ovl = img.copy()
        cv2.fillPoly(ovl, [np.array(p[:4], np.int32)], (0, 0, 255))
        img = cv2.addWeighted(ovl, 0.30, img, 0.70, 0)
        for a, b in EDGES:
            col = (0,0,255) if (a<4 and b<4) else ((0,255,0) if (a>=4 and b>=4) else (255,120,0))
            cv2.line(img, tuple(p[a]), tuple(p[b]), col, 2)
        cv2.putText(img, f"IoU {c['iou']:.2f}", (x1, max(y1-6,12)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0,0,0), 4)
        cv2.putText(img, f"IoU {c['iou']:.2f}", (x1, max(y1-6,12)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255,255,255), 1)

    for i,(t,col) in enumerate([("RED floor = ground footprint (contact)", (0,0,255)),
                                ("GREEN roof / ORANGE verticals", (0,255,0)),
                                ("YELLOW = parking slot ROI", (0,220,220)),
                                ("gray = VPD bbox", (160,160,160))]):
        cv2.putText(img, t, (14, 30+i*28), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0,0,0), 4)
        cv2.putText(img, t, (14, 30+i*28), cv2.FONT_HERSHEY_SIMPLEX, 0.65, col, 2)

    cv2.imwrite(str(SP / f"cuboid_{tag}.jpg"), img)
    print(f"{tag}: 육면체 {len(ov.get(tag,[]))}개 렌더 -> cuboid_{tag}.jpg")
