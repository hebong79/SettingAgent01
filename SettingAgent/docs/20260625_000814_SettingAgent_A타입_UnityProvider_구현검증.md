# SettingAgent A타입(Unity /cameras) 소비 구현 + 라이브 검증

- 작성일: 2026-06-25
- 선행: `20260624_234601_Unity서버_A타입_프리셋목록API_명세.md`(서버 명세)
- 내용: Unity 서버가 `GET /cameras` 를 추가함에 따라 SettingAgent 소비 측(A 공급자)을 구현하고 실서버로 검증.

---

## 1. 구현

- `src/setup/presetProvider.ts`
  - **`UnityPresetProvider`**(A): `GET {baseUrl}/cameras` → `CameraView[]` 매핑. `enabled:false` 카메라 제외, PTZ 보존.
  - **`createPresetProvider(cfg, deps)`** 팩토리: `type` 에 따라 공급자 생성.
    - `unity-api` → UnityPresetProvider (`unityUrl` 비면 `camera.baseUrl`).
    - `discovery` → DiscoveryPresetProvider(B).
    - `camerapos` → null(수동 파일, export 대상 아님).
- 설정 `tools.config.presetProvider`:
  ```json
  { "type": "unity-api", "unityUrl": "" }   // type: camerapos | discovery | unity-api
  ```
- export 경로가 공급자 팩토리를 사용하도록 전환:
  - CLI `npm run export:camerapos`, `POST /setup/export-camerapos` → 설정된 공급자로 목록 수집 → `writeCamerapos()` → `config/camerapos.json`.

## 2. 라이브 검증 (실 Unity 서버, localhost:13100)

`GET /cameras` 실제 응답:
```json
{"cameras":[{"camIdx":1,"name":"PTZ Camera 1","enabled":true,"presets":[
  {"presetIdx":1,"label":"Preset 1","pan":22.0,"tilt":6.8,"zoom":1.6},
  {"presetIdx":2,"label":"Preset 2","pan":56.6,"tilt":7.4,"zoom":1.9},
  {"presetIdx":3,"label":"Preset 3","pan":43.5,"tilt":18.8,"zoom":1.4}]}]}
```

`UnityPresetProvider.listViews()` 결과:
```
공급자: unity-api → 3개
  1:1 "Preset 1" pan=22  tilt=6.8  zoom=1.6
  1:2 "Preset 2" pan=56.6 tilt=7.4 zoom=1.9
  1:3 "Preset 3" pan=43.5 tilt=18.8 zoom=1.4
SetupTarget: {camIdx:1, presetIdx:1, label:"Preset 1", ptz:{pan:22,tilt:6.8,zoom:1.6}}
```
→ **명세대로 정상 취득 확인.**

## 3. A 의 가치 입증 (B 대비)

| 방식 | cam1 프리셋 수 | 정확도 |
|------|----------------|--------|
| B(probing) | **6개** (없는 프리셋에도 영상 반환 → 과다) | ✗ 부정확 |
| **A(/cameras)** | **3개** (서버가 실제 정의 반환) | ✅ 정확 |

→ 자동탐색 B 가 과다 검출하던 문제가 A 로 해결됨. A 가 가능하면 A 가 정확.

## 4. 동작 확인

- `npm run typecheck` → 에러 0
- `npm test` → **73/73 통과** (신규: UnityPresetProvider 매핑/오류/팩토리 6건)
- 라이브: 실 Unity `/cameras` → CameraView 3건 정상(§2).

## 5. 사용법

```bash
# tools.config.presetProvider.type = "unity-api" (기본)
# 1) A 로 camerapos.json 생성
npm run export:camerapos          # 또는 POST /setup/export-camerapos
# 2) 생성된 config/camerapos.json 확인(필요 시 수동 보정)
# 3) 셋업 실행(discovery.enabled=false → 파일 A 사용)
#    POST /setup/run-from-map  또는  npm run e2e
```
- 휴컴스 등 `/cameras` 미제공 카메라: `type=camerapos`(수동) 또는 `type=discovery`(B) 사용.

## 6. 영향도

- `tools.config.presetProvider` 신규(기본 `unity-api`). export 경로만 영향, 셋업은 여전히 camerapos 파일 기준(불변).
- `discovery.enabled` 는 run-from-map 의 라이브 B 경로용으로 유지(별개).
- 신규/변경 파일: presetProvider(UnityProvider+팩토리), export CLI/엔드포인트, index 배선, config.
