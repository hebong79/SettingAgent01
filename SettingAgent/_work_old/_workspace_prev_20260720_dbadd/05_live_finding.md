# 라이브 발견 — DB에 추가 배정이 한 칸 오배정 (goal/loop 틀어짐)

- 리더 경험적 검증 / 2026-07-19 / cam1:preset2

## 관찰(사실)
순수 LPD 검출 4개(중심 x=0.325/0.463/0.635/0.783) → `POST /capture/slots/lpd` → slot_setup.lpd 반영됐으나 **배정이 왼쪽으로 한 칸 밀림**:
| plate x | DB추가 배정 | 정답(nearest front_center) |
|---|---|---|
| 0.325 | slot9 ❌ | slot10 (front 0.323) |
| 0.463 | slot10 ❌ | slot11 (front 0.457) |
| 0.635 | slot12 ✓ | slot12 (front 0.605) |
| 0.783 | slot13 ✓ | slot13 (front 0.770) |

## 근본 원인
`matchPlatesToSlots`(bbox point-in-polygon + 그리디)를 slot_roi 폴리곤에 쓰는데, **원근 왜곡 주차면 폴리곤의 bounding rect가 인접 슬롯과 ~60% 겹침**:
- slot8 x[0.040~0.334], slot9 x[0.145~0.443], slot10 x[0.261~0.561], slot11 x[0.387~0.690], slot12 x[0.527~0.830], slot13 x[0.682~0.985].
- plate 0.325 는 slot8·9·10 세 bbox에 모두 포함 → overlap 그리디가 slot9 선택(오답).
- `matchPlatesToSlots`는 **차량 ROI(타이트 rect)**용으로 설계 — 넓은 원근 주차면 폴리곤엔 부적합.

## 수정 방향
**배정을 nearest slot3d_front_center 로 전환**(discovery 앵커 방식과 동일 의미 — 앞면중심이 판이 있어야 할 위치):
- 각 plate 중심 → 가장 가까운 slot3d_front_center 슬롯에 배정, 전역 1:1(plate당 slot≤1, slot당 plate≤1) 그리디(거리 오름차순).
- front_center 검증: 0.325→slot10, 0.463→slot11, 0.635→slot12, 0.783→slot13 전부 정답.
- front_center null 슬롯 폴백(roi centroid 또는 스킵) 규약 필요.
- (선택) discovery의 lowerFrontAnchor(판 높이 하향) 재사용 시 더 정합 — 단 nearest 만으론 front_center 로 충분(판 간격 ~0.13 > 오차).
- bbox point-in-polygon 게이트를 유지할지(먼 오검출 방어) vs 순수 nearest 로 갈지 판단.

## [v2] 수정 후 라이브 재검증 — 오배정 제거 (성공)
`assignPlatesToSlotViews`를 nearest `lowerFrontAnchor` 전역 1:1 그리디 + MATCH_RADIUS 0.15 로 교체 후 재실측(preset2 lpd 사전 null 정리):
| plate x | v2 배정 | v1(오답) | 정합 |
|---|---|---|---|
| 0.326 | slot10 | slot9 | ✓ (앵커 0.324) |
| 0.463 | slot11 | slot10 | ✓ (앵커 0.457) |
| 0.620 | slot12 | slot12 | ✓ |
| 0.765 | slot13 | slot13 | ✓ |
→ 4개 전부 discovery 앵커 기준과 일치, **한 칸 밀림 제거**, unassigned 0. slot8/9 는 해당 판 미검출(전체프레임 LPD 희소, 정직 null). 종단(검출→/capture/slots/lpd→slot_setup.lpd) 정확 반영 확인.
