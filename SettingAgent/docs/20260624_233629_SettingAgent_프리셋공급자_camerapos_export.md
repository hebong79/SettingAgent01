# SettingAgent 프리셋 공급자(Provider) + camerapos.json Export

- 작성일: 2026-06-24
- 배경: 실 PTZ 는 벤더마다 프리셋 취득 방법이 제각각(현재 **휴컴스**는 프리셋 API 없음 → 수동).
  다른 벤더 대비해 **A(벤더 API) 확장점**을 두고, 어떤 출처든 **camerapos.json 표준 포맷으로 저장**해
  수동·A·B 를 한 포맷으로 통합한다.

---

## 1. 핵심 설계: camerapos.json = 단일 표준 포맷, 공급자는 교체

```
출처(공급자)                         →  camerapos.json (표준)  →  셋업(항상 파일 A 로 동작)
─────────────────────────────────────
① 수동 작성 (휴컴스 등 프리셋 API 없음)
② 자동 탐색 B (DiscoveryPresetProvider)   ──export──▶  config/camerapos.json
③ 벤더 API A (VendorPresetProvider 구현)
```
- 셋업은 항상 신뢰성 높은 **camerapos.json(파일, A방식)** 을 읽음 → 정확·검토·수정 가능.
- 출처가 무엇이든(수동/B/벤더A) 최종 산물은 같은 파일 → **혼용 가능**.

## 2. 구성 요소

| 파일 | 역할 |
|------|------|
| `src/setup/presetProvider.ts` | `PresetProvider` 인터페이스(`listViews()`) + `DiscoveryPresetProvider`(B). 벤더 A 는 이 인터페이스 구현으로 추가(스켈레톤 주석 포함) |
| `src/setup/discover.ts` | `discoverViews()` — 카메라 probing 으로 `CameraView[]`(캡처 PTZ 포함) |
| `src/setup/cameraposWriter.ts` | `writeCamerapos(views, path)` — 표준 포맷(형식 A)으로 저장. `parseCameraViews` 가 그대로 재파싱(왕복 호환) |
| `POST /setup/export-camerapos` | 자동 탐색 결과를 camerapos.json 으로 저장(discovery.enabled 필요) |
| `npm run export:camerapos` | 동일 작업 CLI |

## 3. 동작 흐름

### 3.1 셋업 소스 선택 (기존 + 유지)
`discovery.enabled` 플래그로 셋업 시 소스 결정:
- false(기본): camerapos.json(A, 수동/export 결과) 읽음.
- true: 자동 탐색 B 로 즉석 목록(파일 불요).

### 3.2 Export (신규)
- 카메라 서버 기동 → `npm run export:camerapos`(또는 `POST /setup/export-camerapos`)
- `DiscoveryPresetProvider.listViews()` → `writeCamerapos()` → `config/camerapos.json` 생성(캡처 PTZ 포함).
- 이후 `discovery.enabled=false` 로 두면 셋업이 그 파일로 정확·빠르게 동작. 필요 시 파일 수동 보정.

### 3.3 벤더 A 추가(미래)
프리셋 목록을 주는 카메라/VMS 가 오면:
```ts
class VendorPresetProvider implements PresetProvider {
  readonly name = 'vendor-x';
  async listViews(): Promise<CameraView[]> { /* 벤더 응답 → CameraView[] */ }
}
```
→ export 도구에서 공급자만 교체하면 동일하게 camerapos.json 저장.
(휴컴스는 프리셋 API 부재로 ①수동 또는 ②B-export 사용)

## 4. 표준 포맷 (writeCamerapos 출력 = 형식 A)
```json
{
  "_comment": "SettingAgent 생성(export). 공급자 결과. 수동 편집 가능.",
  "datas": [
    { "cam_id": 1, "datas": [
      { "cam_id": 1, "preset_id": 1, "sname": "C1-P1", "pan": 30, "tilt": 12, "zoom": 2 },
      { "cam_id": 1, "preset_id": 2, "sname": "C1-P2", "pan": 95, "tilt": 12, "zoom": 2.5 }
    ]}
  ]
}
```
- PTZ 없는 뷰는 pan/tilt/zoom 생략(파서가 안전 처리).

## 5. 동작 확인 (실측)

- `npm run typecheck` → 에러 0
- `npm test` → **67/67 통과** (신규: cameraposWriter 왕복/PTZ 2건, discoverViews 갱신 4건)
- export 엔드포인트 inject 스모크(임시 경로): cam1 2프리셋 탐색 → 표준 camerapos.json 저장 + 캡처 PTZ 보존 확인.
- (주의) 실 `config/camerapos.json` 에 대한 라이브 export 는 기존 파일을 덮어쓰므로 본 작업에선 미실행.

## 6. 권고 / 한계

- **휴컴스(프리셋 API 없음)**: ①수동 또는 ②`export:camerapos`(B) 로 1회 생성 후 수동 보정 권장.
  단, B 는 프리셋 경계가 불명확한 서버에서 과다/과소 탐색 가능 → export 결과는 반드시 검토.
- **정확도 우선**: 최종 셋업은 camerapos.json(파일) 기준이 안전(기본 discovery=false).
- **확장**: 벤더 A 공급자는 인터페이스 구현 1개로 추가, 동일 export 파이프라인 재사용.

## 7. 영향도

- 기존 동작 불변: `discovery.enabled=false`(기본) → camerapos 파일 사용(종전과 동일).
- 신규 파일(presetProvider/cameraposWriter/exportCamerapos)·엔드포인트·CLI 추가(가산적).
- `discover.ts` 반환형을 `CameraView[]`(PTZ 포함)로 변경, 호출부(API/e2e)는 `viewsToTargets` 로 연결.
