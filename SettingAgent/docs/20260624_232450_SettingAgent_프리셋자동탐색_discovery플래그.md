# SettingAgent 프리셋 소스 — camerapos(기본) + 자동 탐색(discovery) 플래그

- 작성일: 2026-06-24
- 배경: "preset.json/camerapos.json 을 주차장마다 수동 작성해야 하나?" 에 대한 대안.
- 결정: **camerapos(A) 기본 유지 + config 플래그로 자동 탐색(B) 옵트인.**

---

## 1. 두 방식

| 방식 | 설명 | 프리셋 수 정확도 | 기본 |
|------|------|-----------------|------|
| **A. camerapos(파일)** | camerapos.json 의 cam/preset 목록 사용 | 정확(명시) | ✅ 기본 |
| **B. 자동 탐색(probing)** | cam/preset 인덱스를 순회 캡처, 범위초과 에러에서 종료 | 서버 거동 의존(불확실 가능) | 옵트인 |

- `preset.json` 은 어느 방식이든 **선택**(기대 슬롯 수 교차검증용). 없어도 셋업 동작.

## 2. 설정 (config 플래그)

`tools.config.json`:
```json
"discovery": { "enabled": false, "maxCameras": 32, "maxPresetsPerCamera": 32 }
```
- `enabled=false`(기본): camerapos 사용(A).
- `enabled=true`: 카메라 probing 으로 목록 자동 구성(B). 상한으로 폭주 방지.

## 3. 동작

- `POST /setup/run-from-map` 와 `npm run e2e` 가 `discovery.enabled` 로 소스를 분기.
  - true → `discoverTargets(camera, discovery)` (PTZ 미전송 → 카메라 자체 프리셋 적용).
  - false → `loadSetupTargets(map)`.
- 응답에 `mode: "discovery" | "camerapos"` 표기.

`discoverTargets` 종료 규칙:
- 카메라 preset=1 캡처 실패 → 그 카메라 없음 → 카메라 순회 종료.
- 캡처되던 카메라에서 이후 preset 실패 → 그 카메라 프리셋 끝 → 다음 카메라.
- 상한(maxCameras/maxPresetsPerCamera) 도달 시 중단.

## 4. 실측 결과 (현재 시뮬레이터, 2026-06-24)

```
cam 1: 프리셋 6개 발견 (상한 6 도달)
cam 2: 프리셋 0개 발견  → 종료
발견: 1:1, 1:2, 1:3, 1:4, 1:5, 1:6
```
- **카메라 경계는 깨끗하게 감지**(cam2 = `m_Cameras[2] null` 에러로 종료).
- ⚠️ **프리셋 경계는 불확실**: cam1 이 시도한 1~6 을 모두 이미지로 응답 → 실제 6개인지, 존재하지 않는
  프리셋에도 영상을 주는지 구분 불가. 즉 **프리셋 정확한 개수는 probing 으로 보장되지 않음**.

## 5. 의견/권고 (중요)

- **프리셋의 정확한 개수가 필요하면 A(camerapos)가 정답.** B 는 프리셋 경계 신호가 없는 서버(시뮬·다수 실 PTZ)에서
  과다/과소 탐색이 발생할 수 있다. → 기본 A, B 는 옵트인 유지가 타당(실측으로 확인됨).
- 실 PTZ 는 ONVIF `GetPresets` 등이 있으나 카메라/VMS 마다 노출이 제각각이라 일반화 불가.
- **장기 권장(A 자동화)**: 카메라/Unity 서버에 "카메라/프리셋 목록 조회" API 를 추가하면,
  파일 없이도 **정확한** 목록을 런타임에 취득 가능(가장 깔끔). 그 전까지는:
  - Unity 가 프리셋 정의를 camerapos.json 으로 **1회 export**(반자동) → 주차장마다 손으로 적지 않음.
- **개선 아이디어(후속)**: B 로 탐색한 결과를 camerapos.json 으로 저장해 두면, 이후 실행은 A(파일)로
  정확·빠르게 재사용 가능(탐색 1회 → 파일화). 필요 시 `discovery.saveToCamerapos` 플래그로 추가 가능.

## 6. 동작 확인

- `npm run typecheck` → 에러 0
- `npm test` → **65/65 통과** (신규 4: discoverTargets 경계/상한/빈목록)
- 실 시뮬 probing → cam 경계 감지 정상(§4), 프리셋 경계 불확실 확인.

## 7. 영향도

- `tools.config.discovery` 신규(기본 `enabled:false`) → 기존 camerapos 동작 불변.
- API 분기 추가, 기존 `/setup/run-from-map`(camerapos) 동작은 플래그 false 시 동일.
- `preset.json` 은 계속 선택(교차검증). 없으면 검증 생략.
