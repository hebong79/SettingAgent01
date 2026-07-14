# [OBB-LPD] Oriented bounding box licence plate detection

번호판 OBB(Oriented Bounding Box) 검출 API. 축정렬 bbox 가 아니라 회전 4점 폴리곤을 반환한다.

- **모델**: `weights/yolov11l_obb_lpd.pt` (YOLO11 OBB), `task="obb"` 로 로드.
- **탐지 클래스**: `['car_license_plate']`
- **응답 스키마**: `schemas/yolo.py` 의 `ImageAnalysisResponse`

## 응답 스키마 (`ImageAnalysisResponse`)

| 필드 | 타입 | 설명 |
|------|------|------|
| `success` | `bool` | 검출 성공 여부 (`polygons` 가 1개 이상이면 `true`) |
| `id` | `int` | 서버 메모리에 저장된 이미지 ID (1부터 증가) |
| `polygons` | `List[List[List[float]]]` | 검출별 4점 폴리곤. 각 검출 = `[[x0,y0],[x1,y1],[x2,y2],[x3,y3]]` (픽셀) |
| `confidences` | `List[float]` | 각 검출의 신뢰도 |
| `classes` | `List[str]` | 각 검출의 클래스명 (예: `"car_license_plate"`) |

- **점 순서 규약**: ultralytics OBB (top-left 시작, 시계방향 `TL -> TR -> BR -> BL`). 서버는 재정렬하지 않고 그대로 전달한다.
- **좌표계**: 픽셀 (정규화 아님). 소비 측이 이미지 크기로 정규화한다.

## 번호판 OBB 검출 — `POST /lpd/api/v1/imgupload`

**요청 (cURL)**
```bash
curl -X 'POST' \
  'http://localhost/lpd/api/v1/imgupload' \
  -H 'accept: application/json' \
  -H 'Content-Type: multipart/form-data' \
  -F 'file=@image.jpg;type=image/jpeg'
```

**응답** — `201 Created`
```json
{
  "success": true,
  "id": 1,
  "polygons": [
    [
      [551.58, 358.88],
      [1084.72, 360.10],
      [1082.00, 452.92],
      [549.10, 450.50]
    ]
  ],
  "confidences": [
    0.9543854594230652
  ],
  "classes": [
    "car_license_plate"
  ]
}
```

**검출 결과가 없을 때**
```json
{
  "success": false,
  "id": 2,
  "polygons": [],
  "confidences": [],
  "classes": []
}
```

## 주석 이미지 다운로드 — `GET /lpd/api/v1/resp/img_{image_id}`

검출 후 서버 메모리에 저장된 주석(annotated) 이미지를 JPG 바이너리로 반환한다.

- `200 OK` : JPG 바이너리
- `404 Not Found` : 해당 ID 없음
