# VPD API 응답 값 예시

FastAPI 기반 **VPD (Vehicle Parking Detection) API** 서버가 실행될 때 각 엔드포인트가 반환하는 값의 예시입니다.

- **서버 주소**: `http://0.0.0.0:9081` (`.env`의 `HOST`, `PORT` 기준)
- **모델**: YOLO11 차량 탐지(`detect`) / 세그멘테이션(`segment`)
- **탐지 클래스**: `['car']`
- **공통 응답 스키마**: `schemas/yolo.py`의 `ImageAnalysisResponse`

## 공통 응답 스키마 (`ImageAnalysisResponse`)

| 필드 | 타입 | 설명 |
|------|------|------|
| `success` | `bool` | 탐지 성공 여부 (bbox가 1개 이상이면 `true`) |
| `id` | `int` | 서버 메모리에 저장된 이미지 ID (1부터 증가) |
| `bboxes` | `List[List[float]]` | 바운딩 박스 좌표 `[x1, y1, x2, y2]` 리스트 |
| `masks` | `List[List[List[int]]]` | 세그멘테이션 폴리곤 좌표 리스트 (detect는 빈 배열 `[]`) |
| `confidences` | `List[float]` | 각 탐지의 신뢰도 점수 |
| `classes` | `List[str]` | 각 탐지의 클래스명 (예: `"car"`) |

---

## 1. 차량 탐지 — `POST /vpd/api/v2/det/imgupload`

이미지를 업로드하면 바운딩 박스를 반환합니다. (`masks`는 항상 빈 배열)

**요청 (cURL)**
```bash
curl -X 'POST' \
  'http://localhost:9081/vpd/api/v2/det/imgupload' \
  -H 'accept: application/json' \
  -H 'Content-Type: multipart/form-data' \
  -F 'file=@image.jpg;type=image/jpeg'
```

**응답** — `201 Created`
```json
{
  "success": true,
  "id": 1,
  "bboxes": [
    [551.58, 358.88, 1084.72, 452.92],
    [120.0, 210.5, 480.3, 390.7]
  ],
  "masks": [],
  "confidences": [
    0.9543854594230652,
    0.8721030354499817
  ],
  "classes": [
    "car",
    "car"
  ]
}
```

**탐지 결과가 없을 때**
```json
{
  "success": false,
  "id": 2,
  "bboxes": [],
  "masks": [],
  "confidences": [],
  "classes": []
}
```

---

## 2. 차량 세그멘테이션 — `POST /vpd/api/v2/seg/imgupload`

이미지를 업로드하면 바운딩 박스와 함께 세그멘테이션 폴리곤(`masks`)을 반환합니다.

**요청 (cURL)**
```bash
curl -X 'POST' \
  'http://localhost:9081/vpd/api/v2/seg/imgupload' \
  -H 'accept: application/json' \
  -H 'Content-Type: multipart/form-data' \
  -F 'file=@image.jpg;type=image/jpeg'
```

**응답** — `201 Created`
```json
{
  "success": true,
  "id": 3,
  "bboxes": [
    [551.58, 358.88, 1084.72, 452.92]
  ],
  "masks": [
    [
      [560, 360],
      [1080, 362],
      [1082, 450],
      [558, 448]
    ]
  ],
  "confidences": [
    0.9412540793418884
  ],
  "classes": [
    "car"
  ]
}
```

> `masks`의 각 항목은 하나의 객체를 이루는 폴리곤 꼭짓점 `[x, y]` 좌표 배열입니다.

---

## 3. 주석 이미지 다운로드 — `GET /vpd/api/v2/resp/img_{image_id}`

탐지/세그멘테이션 후 서버 메모리에 저장된 주석(annotated) 이미지를 JPG 바이너리로 반환합니다.

**요청 (cURL)**
```bash
curl -X 'GET' \
  'http://localhost:9081/vpd/api/v2/resp/img_1' \
  -H 'accept: image/jpg' \
  --output result.jpg
```

**응답**
- `200 OK` : JPG 바이너리 이미지 (`Content-Type: image/jpg`) — JSON이 아닌 이미지 데이터
- `404 Not Found` : 해당 ID의 이미지가 없을 때
```json
{
  "detail": "Image not found"
}
```

---

## 참고: 서버 시작 시점의 동작

`main.py` 실행 시 JSON을 반환하는 것이 아니라, FastAPI 앱이 기동되며 다음이 수행됩니다.

- `9081` 포트에서 Uvicorn 서버 리슨 시작
- 라우터 로딩 시 YOLO 가중치 로드
  (`weights/vpd_det_v2_yolov11l.pt`, `weights/vpd_seg_v2_yolov11l.pt`)
- CORS 전체 허용, Logfire 계측 활성화

자동 생성되는 OpenAPI 문서/스키마는 아래에서 확인할 수 있습니다.

- Swagger UI: `http://localhost:9081/docs`
- OpenAPI JSON: `http://localhost:9081/openapi.json`
