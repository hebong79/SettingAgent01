# SettingAgent 셋업 산출물(최종 프리셋/주차면) 저장 구조 — `setup_artifact.json`

- 작성일: 2026-06-24
- 대상: 셋업 완료 시 저장되는 **최종 주차면 확보 결과**의 데이터 구조
- 저장 위치: `data/setup_artifact.json` (`store.dataDir` 기준, `Repository.saveArtifact`)
- 타입 정의: `@parkagent/types`(공유) + `SettingAgent/src/domain/types.ts`(`SetupArtifact`)

---

## 0. 입력 `preset.json` vs 출력 `setup_artifact.json` (혼동 주의)

| 파일 | 역할 | 성격 | 예 |
|------|------|------|----|
| `config/preset.json` | **입력**. 프리셋별 "기대 주차면 개수(faceCount)" | 교차검증용(사람이 미리 채움) | `{camIdx,idx,faceCount}` |
| `data/setup_artifact.json` | **출력**. 셋업이 실제 확보한 최종 프리셋·주차면·ROI·전역인덱스 | 시스템이 생성(Action/DM 이 읽는 계약) | 아래 §2 |

> 즉 "실제 프리셋(최종 주차면 확보) 저장 구조"는 **`setup_artifact.json` = `SetupArtifact`** 이다.

---

## 1. 최상위 구조 `SetupArtifact`

```ts
interface SetupArtifact {
  presets: Preset[];            // 프리셋 목록(카메라 뷰 단위)
  slots: ParkingSlot[];         // 주차면 목록(ROI 포함)
  globalIndex: GlobalSlotIndex[]; // 전 카메라·전 프리셋 정렬된 전역 슬롯 인덱스
  createdAt: string;            // 생성 시각(ISO8601)
  warnings?: string[];          // (선택) 교차검증/게이트 경고
  report?: string;              // (선택) LLM 게이트3 한글 설치 리포트
}
```

| 필드 | 타입 | 의미 |
|------|------|------|
| `presets` | `Preset[]` | 각 카메라 프리셋(뷰)과 그 프리셋이 비추는 주차면 ID·PTZ |
| `slots` | `ParkingSlot[]` | 주차면 단위. 프리셋 이미지 좌표계의 **차량 ROI**(+선택 **번호판 ROI**) 보관 |
| `globalIndex` | `GlobalSlotIndex[]` | 전체 주차면을 `cam→preset→위치` 로 정렬해 1-based 전역 번호 부여(할일 7) |
| `createdAt` | `string` | 산출물 생성 시각 |
| `warnings` | `string[]?` | 기대≠검출 불일치, LPD 매칭 누락, 게이트 제외/병합 등 |
| `report` | `string?` | LLM 활성 시 게이트3 가 쓴 한글 설치 리포트 |

---

## 2. 하위 타입

### 2.1 `Preset` — 카메라 프리셋(뷰)
```ts
interface Preset {
  camIdx: number;          // 1-based
  presetIdx: number;       // 1-based
  label: string;           // camerapos 의 sname 또는 "cam:preset"
  coveredSlotIds: string[];// 이 프리셋이 비추는 주차면 ID(프리셋 내 위치 순서)
  pan?: number;            // 캡처 시점 PTZ(보관용)
  tilt?: number;
  zoom?: number;
}
```
- `pan/tilt/zoom` 은 `/req_img` 응답의 실제 PTZ(또는 camerapos 입력값)로 보관 → 재방문 시 동일 뷰 재현.

### 2.2 `ParkingSlot` — 주차면(핵심)
```ts
interface ParkingSlot {
  slotId: string;                                   // 안정 식별자 c{cam}p{preset}s{pos}
  zone: string;                                     // 존 라벨(기본 cam{n}, 게이트2 에서 "A-01" 등으로 갱신 가능)
  roiByPreset: Record<string, NormalizedRect>;      // 차량 ROI (VPD). key=`${cam}:${preset}`
  plateRoiByPreset?: Record<string, NormalizedRect>;// 번호판 ROI (LPD, lpdEnabled 시). 센터라이징 prior
}
```
- **key 가 `${camIdx}:${presetIdx}` 인 맵** 인 이유: 한 주차면이 여러 프리셋에서 보일 수 있어, 프리셋별로 다른 ROI 를 보관하기 위함.
- `roiByPreset`(차량)과 `plateRoiByPreset`(번호판)은 같은 key 로 짝을 이뤄 **차량 bbox + 번호판 bbox 둘 다** 제공.

### 2.3 `GlobalSlotIndex` — 전역 슬롯 인덱스
```ts
interface GlobalSlotIndex {
  globalIdx: number;   // 1-based 전역 순번
  slotId: string;
  camIdx: number;
  presetIdx: number;
}
```
- 정렬 규칙(확정): `camIdx ASC → presetIdx ASC → 프리셋 내 위치(positionIdx) ASC`.

### 2.4 `NormalizedRect` — 정규화 사각형
```ts
interface NormalizedRect { x: number; y: number; w: number; h: number; } // 모두 0~1
```
- 좌상단 `(x,y)` + 너비/높이 `(w,h)`, 이미지 해상도 무관(정규화). 픽셀 환산 = 값 × 이미지 폭/높이.

---

## 3. 공통 규약

- **인덱스 1-based**: camIdx, presetIdx, 프리셋 내 위치, globalIdx 모두 1부터.
- **slotId 형식**: `c{camIdx}p{presetIdx}s{positionIdx}` (예: `c1p2s3` = 카메라1·프리셋2·위치3).
- **프리셋 key**: `${camIdx}:${presetIdx}` (예: `1:2`). roiByPreset/plateRoiByPreset 의 키.
- **위치(positionIdx)**: 프리셋 이미지에서 상→하 밴드, 같은 밴드 내 좌→우 순서.
- **좌표계**: 모든 ROI 는 해당 프리셋 이미지 기준 정규화(0~1).

---

## 4. 예시 (`data/setup_artifact.json`)

camerapos: cam1(프리셋1·2), cam2(프리셋1) / preset.json faceCount: 1:1=2, 1:2=3, 2:1=1 / `lpdEnabled=true` 가정.

```json
{
  "createdAt": "2026-06-24T22:50:00.000Z",
  "presets": [
    { "camIdx": 1, "presetIdx": 1, "label": "C1-P1", "coveredSlotIds": ["c1p1s1", "c1p1s2"], "pan": 30.0, "tilt": 12.0, "zoom": 2.0 },
    { "camIdx": 1, "presetIdx": 2, "label": "C1-P2", "coveredSlotIds": ["c1p2s1", "c1p2s2", "c1p2s3"], "pan": 95.0, "tilt": 12.0, "zoom": 2.5 },
    { "camIdx": 2, "presetIdx": 1, "label": "C2-P1", "coveredSlotIds": ["c2p1s1"], "pan": 200.0, "tilt": 10.0, "zoom": 3.0 }
  ],
  "slots": [
    {
      "slotId": "c1p1s1", "zone": "A-01",
      "roiByPreset":      { "1:1": { "x": 0.12, "y": 0.40, "w": 0.18, "h": 0.22 } },
      "plateRoiByPreset": { "1:1": { "x": 0.18, "y": 0.55, "w": 0.05, "h": 0.03 } }
    },
    {
      "slotId": "c1p1s2", "zone": "A-02",
      "roiByPreset":      { "1:1": { "x": 0.55, "y": 0.41, "w": 0.19, "h": 0.23 } },
      "plateRoiByPreset": { "1:1": { "x": 0.62, "y": 0.56, "w": 0.05, "h": 0.03 } }
    },
    { "slotId": "c1p2s1", "zone": "cam1", "roiByPreset": { "1:2": { "x": 0.10, "y": 0.38, "w": 0.17, "h": 0.21 } } },
    { "slotId": "c1p2s2", "zone": "cam1", "roiByPreset": { "1:2": { "x": 0.40, "y": 0.39, "w": 0.18, "h": 0.22 } } },
    { "slotId": "c1p2s3", "zone": "cam1", "roiByPreset": { "1:2": { "x": 0.70, "y": 0.40, "w": 0.18, "h": 0.22 } } },
    { "slotId": "c2p1s1", "zone": "cam2", "roiByPreset": { "2:1": { "x": 0.45, "y": 0.45, "w": 0.20, "h": 0.25 } } }
  ],
  "globalIndex": [
    { "globalIdx": 1, "slotId": "c1p1s1", "camIdx": 1, "presetIdx": 1 },
    { "globalIdx": 2, "slotId": "c1p1s2", "camIdx": 1, "presetIdx": 1 },
    { "globalIdx": 3, "slotId": "c1p2s1", "camIdx": 1, "presetIdx": 2 },
    { "globalIdx": 4, "slotId": "c1p2s2", "camIdx": 1, "presetIdx": 2 },
    { "globalIdx": 5, "slotId": "c1p2s3", "camIdx": 1, "presetIdx": 2 },
    { "globalIdx": 6, "slotId": "c2p1s1", "camIdx": 2, "presetIdx": 1 }
  ],
  "warnings": [],
  "report": "주차장 셋업 완료. 총 6면 확보(카메라2/프리셋3). 기대치와 일치."
}
```

> `plateRoiByPreset` 는 `lpdEnabled=true` 이고 번호판 매칭에 성공한 면에만 존재(선택적).
> 위 예에서 c1p1 면은 번호판까지 확보, 나머지는 차량 ROI 만 확보된 상태를 표현.

---

## 5. 생성·소비

- **생성**: `SetupOrchestrator.run()` → `Repository.saveArtifact()` → `data/setup_artifact.json`.
- **조회**: SettingAgent `GET /mapping` 이 이 산출물을 그대로 반환.
- **소비(향후)**: ActionAgent(점유 귀속·센터라이징 — `roiByPreset`/`plateRoiByPreset` 사용),
  DMAgent(슬롯 상태·전역 인덱스 기준). → 그래서 이 구조는 **에이전트 간 계약**이며 변경 시 3자 동시 영향.

---

## 6. 요약

- `config/preset.json` = 입력(기대 개수, 교차검증). 최종 결과 아님.
- **최종 프리셋/주차면 저장 구조 = `SetupArtifact`(`data/setup_artifact.json`)** = `presets` + `slots`(차량/번호판 ROI) + `globalIndex`(+warnings/report).
- 1-based 인덱스, 정규화 ROI, `c{cam}p{preset}s{pos}` slotId, `${cam}:${preset}` 프리셋 key 규약.
