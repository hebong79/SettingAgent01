# SettingAgent

주차장 **설치 시 1회** 동작하는 셋업 에이전트. 카메라 프리셋을 순회하며 차량을 검지(VPD)하고
주차면 ROI·**전역 슬롯 인덱스**를 만들어 `data/setup_artifact.json` 으로 저장한다(이후 Action/DM 이 사용).
번호판 위치(LPD)와 LLM 비전 게이트로 품질을 보강할 수 있다.

> 구조: **LLM 두뇌(model-agnostic) + MCP 도구 + 결정형 셋업 파이프라인**. 좌표는 검출이 보장(LLM 은 판정만).

---

## 빠른 시작

```bash
# 0) 의존성 설치 (워크스페이스 루트에서 1회 — @parkagent/types 자동 링크)
cd d:/Work/Parking3D/AgentVLA/ParkAgent && npm install

# 1) 외부 서버 기동 확인: 카메라(13100), VPD(9081) [+ LPD 9082, LLM(:11434) 선택]
cd SettingAgent
npm run e2e                 # 헬스→셋업까지 한 번에 점검(서버 떠 있어야 함)

# 2) 카메라에서 프리셋 목록 받아 camerapos.json 생성 (presetProvider.type=unity-api)
npm run export:camerapos

# 3) 서버 기동 후 셋업 실행
npm run start               # REST :13020
curl -X POST http://localhost:13020/setup/run-from-map
curl http://localhost:13020/mapping | jq .
```

LLM 서버가 없으면 `config/llm.config.json` 의 `llm.enabled=false` → 결정형 경로만으로 정상 동작.
다른 PC 로 옮기면 config 의 **호스트만** 변경(코드 수정 불필요).

---

## 사전 준비

- Node.js 20+
- 외부 서버(필요한 것만)

| 서버 | 기본 주소 | 필수 | 비고 |
|------|-----------|------|------|
| 카메라(Unity/실 PTZ) | `http://localhost:13100` | ✅ | 캡처/이동. A타입이면 `GET /cameras` 제공 |
| VPD(차량검출) | `http://127.0.0.1:9081` | ✅ | `Sub/da_vpd_api` |
| LPD(번호판검출) | `http://127.0.0.1:9082` | 선택 | `setup.lpdEnabled=true` 일 때 |
| LLM(두뇌) | `http://192.168.0.210:11434/v1` | 선택 | gemma4:12b(Ollama), `llm.enabled=true` 일 때 |

---

## 설정 (config/ — 역할 분리 2파일)

- **`tools.config.json`** — 도구·셋업 파라미터: `camera`/`vpd`/`lpd`/`setup`/`map`/`presetProvider`/`discovery`/`server`/`store`/`viewer`(+옵셔널 `cameraSources`)
- **`llm.config.json`** — LLM 두뇌 + MCP + 단계별 프롬프트: `llm`/`mcp`/`setupPrompts`

자주 바꾸는 값:

| 키 | 의미 |
|----|------|
| `tools.presetProvider.type` | 프리셋 출처: `unity-api`(A·권장) / `discovery`(B) / `camerapos`(수동) |
| `tools.presetProvider.refreshOnRun` | 셋업 직전(run-from-map 시작 시) 공급자로 camerapos.json 자동 갱신 |
| `tools.setup.lpdEnabled` | 번호판 위치 저장(센터라이징 prior) |
| `tools.setup.accumFrames` | 1=단일프레임(시뮬), >1=다프레임 누적(실 PTZ) |
| `tools.discovery.enabled` | 셋업 시 즉석 자동탐색(B) |
| `llm.llm.enabled` | LLM 게이트 on/off |
| `llm.setupPrompts.stageNEnabled` | 단계별(1 비전판정/2 중복·라벨/3 리포트) on/off |
| `tools.viewer.enabled` | 웹 뷰어(SPA + `/viewer/api/*`) 서빙 on/off. `false`=헤드리스(순수 에이전트) |

> 프리셋 출처 3가지: **A**(카메라 `/cameras`), **B**(자동탐색 probing), **수동**(camerapos 직접 작성).
> 어느 출처든 `npm run export:camerapos` 로 `camerapos.json` 에 모아 두면 셋업은 항상 파일 기준으로 동작.
>
> **camerapos.json 갱신 시점**:
> - `npm run export:camerapos` / `POST /setup/export-camerapos` — 언제든 명시적으로 갱신(검토·수동편집용).
> - `presetProvider.refreshOnRun=true` — `/setup/run-from-map` **시작 시** 공급자(A/B)로 자동 갱신 후 그 목록으로 셋업.
>   (그냥 서버를 켜는 것만으로는 갱신되지 않음. 셋업 산출물 `setup_artifact.json` 은 셋업 **끝**에 저장.)

---

## REST API (:13020)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/health` | 카메라/VPD/두뇌 상태 |
| POST | `/setup/run-from-map` | camerapos(또는 discovery)로 셋업 실행 |
| POST | `/setup/run` `{targets:[...]}` | 대상 프리셋 직접 지정 실행 |
| POST | `/setup/export-camerapos` | 공급자(A/B)로 camerapos.json 생성 |
| GET | `/setup/status` | 진행 상태 |
| GET | `/mapping` | 최종 산출물 조회 |
| PUT | `/mapping` (·`/viewer/api/mapping`) | 편집된 산출물 영속화(주차면 ROI 삭제·크기조정·전역 인덱스 수동 매핑). zod→`validateCoverage` 정합 게이트 통과 시 저장, 불일치 400 미저장. 문서: `docs/20260630_112704_주차면편집_수동인덱스_표시제어.md` |
| GET | `/brain/ping` | LLM 연결 점검 |
| POST | `/brain/review` | 산출물 LLM 검토 |
| GET | `/viewer/`, `/viewer/api/*` | 웹 뷰어(SPA + 카메라/스냅샷/이동/mapping). `viewer.enabled=true` 일 때만. 접속: `http://localhost:13020/viewer/` |
| POST | `/capture/start`·`/stop`·`/finalize`, GET `/capture/status`·`/runs` | 정밀 수집(반복 관측→SQLite 누적→집계→LLM 보정→`setup_artifact.json`). 단발 `/setup/*` 보완. 문서: `docs/20260625_233818_정밀주차면_반복수집_구현문서.md` |
| POST | `/calibrate/ptz`, GET `/calibrate/status`·`/result` | 주차면별 번호판 중심정렬·줌 PTZ 캘리브레이션(setup_artifact 읽기전용 → `data/slot_ptz.json`). 결정형 비례제어 + LLM 자문(폴백). 문서: `docs/20260630_225107_PTZ캘리브레이션_slot_ptz.md`(+`..._영향도분석.md`) |

> 바닥 ROI(floor ROI): `llm.config` 의 `floorRoi.enabled=true` 시 정밀수집 체크포인트마다 LLM 비전이 차량 지면 접지 4점 사변형을 추론해 `slots[].floorRoiByPreset` 에 가산. 뷰어 `바닥` 토글(연두 폴리곤)로 표시. 문서: `docs/20260629_235626_차량바닥ROI_LLM비전_floorRoi.md`

---

## npm 스크립트

```bash
npm run start             # 서버 기동(:13020)
npm run dev               # 변경 감시 기동
npm run e2e               # 실서버 셋업 스모크
npm run export:camerapos  # camerapos.json 생성(A/B)
npm run typecheck         # 타입 검사
npm test                  # 유닛테스트(외부 서버 불필요)
npm run mcp               # MCP 도구 서버(stdio)
```

---

## 산출물

`data/setup_artifact.json` (= `GET /mapping`):
```
presets[]     { camIdx, presetIdx, label, coveredSlotIds[], pan/tilt/zoom }
slots[]       { slotId, zone, roiByPreset(차량 ROI), plateRoiByPreset?(번호판 ROI), floorRoiByPreset?(바닥 점유 4점 사변형) }
globalIndex[] { globalIdx, slotId, camIdx, presetIdx }   // cam→preset→위치, 1-based
warnings?, report?
```

> 뷰어 검수/분석 탭에서 주차면(ROI) **선택·삭제·크기조정**과 **전역 인덱스 수동 재정렬**을 한 뒤 "저장"(`PUT /mapping`)으로 이 파일을 갱신할 수 있다(정합 게이트 통과 시에만 기록).

`data/slot_ptz.json` (= `GET /calibrate/result`, 별도 산출물 — setup_artifact 비오염):
```
createdAt, items[] { camIdx, presetIdx, slotId, globalIdx, ptz{pan,tilt,zoom}, plateWidth, centered, converged, reason? }
```
> 번호판 ROI 보유 주차면마다 중심정렬·줌 PTZ 를 구해 저장(ActionAgent 센터링 prior 후보). `POST /calibrate/ptz` 로 생성.

---

## 트러블슈팅

| 증상 | 해결 |
|------|------|
| `/health` 의 vpd/lpd 가 false(404) | 정상(해당 서버 `/health` 미구현). 검출 경로는 동작 |
| `m_Cameras[n] null` (500) | camerapos 가 없는 카메라 참조 → A(`/cameras`)/export 로 맞춤 |
| 자동탐색 프리셋 과다 | `presetProvider.type=unity-api`(A) 권장 |
| `기대 슬롯 N ≠ 검출 M` 경고 | preset.json 보정 또는 무시(검증용, 비차단) |
| LLM 느림/불필요 | `llm.enabled=false` |

---

## 문서 (docs/)

- 실행 가이드: `20260625_001113_SettingAgent_실행가이드.md`
- 산출물 구조: `20260624_225612_..._setup_artifact_구조.md`
- tools.config 항목: `20260624_222018_..._tools.config_항목설명.md`
- LLM 단계 프롬프트(전략 C): `20260624_202329_..._전략C_단계별프롬프트_구현.md`
- 프리셋 공급자/Export: `20260624_233629_..._프리셋공급자_camerapos_export.md`
- A타입(Unity /cameras): `20260625_000814_..._A타입_UnityProvider_구현검증.md`
- 웹 뷰어 재통합(단일 프로세스): `20260626_233954_SettingViewer_SettingAgent_재통합.md`(+ `..._재통합_영향도분석.md`)
