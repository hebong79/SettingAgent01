# 주차면 점유영역/주차면 영역 프롬프트

상태: 정리 문서  
작성 목적: 주차면 영역을 자동으로 그리기 위해 사용 중인 VLM 프롬프트와 실측 결과를 한곳에 모은다.

## 핵심 결론

- 주차면 영역 검출의 핵심은 **차량 박스가 아니라 바닥의 주차 슬롯을 그리게 하는 것**이다.
- 점유된 칸도 차량 차체를 박스로 잡으면 안 되고, 차량이 서 있는 **GROUND SLOT**을 잡아야 한다.
- 현재 구현에서 실제 주차면 후보 박스 검출 프롬프트는 `apps/backend-core/src/layout-detector.mjs`의 `PROMPT`이다.
- `apps/backend-core/src/vlm-detector.mjs`의 `CAR_PROMPT`는 주차면 영역이 아니라 주차된 차량 검출/점 생성용이다.

## 주차면 영역 검출 프롬프트

위치: `apps/backend-core/src/layout-detector.mjs`

용도:

- 광각 CCTV 프레임에서 빈 칸과 점유된 칸을 모두 찾는다.
- 반환값은 1920x1080 이미지 좌표계의 axis-aligned box이다.
- VLM은 PTZ를 계산하지 않는다. PTZ 유도는 카메라 `centerBox`가 담당한다.

```text
This is one frame from a fixed CCTV camera looking at an outdoor parking lot at an
oblique angle (1920x1080). Locate the PAINTED PARKING BAYS -- the rectangular ground
slots a single car parks in. You are mapping the GROUND, not the cars.

A parking bay is a rectangle of ground delimited by painted lines (white or yellow),
usually with a wheel stop / parking block at its far end. Bays sit side by side in
rows. Box EVERY bay you can see, empty or occupied:
- EMPTY bay  -> box the painted rectangle on the ground.
- OCCUPIED bay -> box the GROUND SLOT the car stands in, NOT the car body. The box
  BOTTOM edge = where the car's tyres meet the ground (near end of the slot); the box
  TOP edge = the slot's far end (wheel stop / rear painted line). The box should be
  about as TALL as an empty bay in the same row -- never reach up to the car's roof.
  Do NOT box cars that are driving or standing outside a marked bay.

The oblique view makes each bay look like a trapezoid; return an axis-aligned box
that tightly encloses that trapezoid's four corners. Every box -- empty or occupied --
is a flat slot lying on the ground, not a tall vertical silhouette.

Scan the WHOLE frame, including far rows and bays on darker pavement, and report
every bay you can make out (distant ones look small). It is better to over-detect.

Return ONLY JSON, no prose:
{"spaces":[{"id":1,"box":{"startX":0,"startY":0,"endX":0,"endY":0},"occupied":true,"note":"empty | car"}]}

Rules:
- Integer pixel coords in THIS image: x in 0..1920, y in 0..1080, startX<endX, startY<endY.
- One box per bay. Keep neighbouring bays in the same row similar in size and aligned.
- Number bays left-to-right, top row first.
- Exclude driving lanes, crosswalks, sidewalks, grass/landscaping, ramps, and the camera's dark frame/pillars.
- Prefer recall: include a faint or partly-occluded bay rather than skip it.
```

## 차량 검출 프롬프트

위치: `apps/backend-core/src/vlm-detector.mjs`

용도:

- 현재 프레임에서 주차된 차량을 찾고, 차량 박스와 중심점을 반환한다.
- 이 프롬프트는 주차면 바닥 영역이 아니라 **주차 차량**을 찾는 용도이다.
- UI의 "VLM 주차인식" 버튼 쪽과 연결된다.

```text
This is one frame from a fixed CCTV camera viewing an outdoor parking lot at an
oblique angle (1920x1080). Find every CAR that is PARKED in a marked parking bay.

For each parked car, return a tight axis-aligned bounding box around the visible CAR body.
- Include cars parked in bays, even partly occluded or in far/dark rows (they look small).
- EXCLUDE vehicles that are driving or stopped in a lane/driveway/crosswalk (not in a bay).
- EXCLUDE empty bays (no car).
- One box per car.

Return ONLY JSON, no prose:
{"cars":[{"box":{"startX":0,"startY":0,"endX":0,"endY":0}}]}

Rules:
- Integer pixel coords in THIS image: x in 0..1920, y in 0..1080, startX<endX, startY<endY.
- Prefer recall: include a faint or partly-occluded parked car rather than skip it.
```

## 실측 결과

출처: `docs/parking-layout-tool.md`의 "Opus 자동 후보 검출 -- 가능 범위와 한계"

실측 환경:

- 카메라: `cam-001`
- 날짜: 2026-06-13
- 방식: `POST /api/layout/detect`로 현재 광각 프레임을 Anthropic Claude Opus에 보내 주차면 박스 후보를 받음

확인한 사실:

- 프롬프트가 "차가 있으면 차를 박스로"라고 시키면 VLM은 주차면이 아니라 차량을 따라간다.
- "차가 아니라 바닥의 주차 슬롯, 즉 타이어가 닿는 곳부터 카스토퍼/후방 주차선까지를 잡아라"라고 바꾸면 주차면을 잡는다.
- 따라서 "차량 -> 주차면" 전환은 프롬프트만으로 해결 가능했고, 이 단계에서는 파인튜닝이 필수는 아니었다.
- 다만 픽셀 정밀도와 재현성은 프롬프트만으로 한계가 있었다.
- 같은 화면에서도 검출 개수가 6개, 10개, 11개처럼 흔들렸다.
- 비스듬한 CCTV 시점에서 바닥 사각형의 정밀 위치를 추정하는 것은 일반 VLM의 약점이다.
- 수작업으로 그린 박스만큼의 정밀도는 나오지 않는다.

운영 판단:

- 자동 검출은 시간 절약용 1차 후보로 사용한다.
- 권장 흐름은 "자동 후보 -> 클릭해서 채택 -> 어긋난 몇 개만 편집기로 보정"이다.
- 빠진 면을 새로 그리는 것보다, 이미 잡힌 후보를 미세 조정하는 편이 빠르다.
- 그래서 프롬프트는 precision보다 recall, 즉 많이 잡는 쪽을 우선한다.
- 무인 정밀 자동화가 필요해지면 그때 전용 디텍터나 LoRA 파인튜닝을 검토한다.
- 이때 운영자가 수작업으로 그린 박스들이 학습 데이터가 된다.

## 구현 메모

- `/api/layout/detect`는 VLM에게 2D 픽셀 박스만 요청한다.
- 주차면 박스 좌표는 1920x1080 논리 프레임 기준으로 저장한다.
- 카메라 이동은 박스 중심/영역을 `centerBox`로 넘겨 PTZ를 유도한다.
- 주차면 정의의 목적은 이후 점유 판정, 번호판 조준, PTZ 룩업맵의 기반을 만드는 것이다.

