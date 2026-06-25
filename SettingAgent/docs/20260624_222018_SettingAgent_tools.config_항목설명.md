# SettingAgent `tools.config.json` 항목 설명

- 작성일: 2026-06-24
- 대상 파일: `SettingAgent/config/tools.config.json`
- 스키마/검증: `src/config/toolsConfig.ts` (zod), 로더 `loadToolsConfig()`
- 성격: **MCP 도구(능력 엔드포인트) + 셋업/서버/저장 등 "기타" 설정**. LLM 두뇌·프롬프트는 `llm.config.json`(분리).

> 모든 섹션은 로더가 기본값과 **섹션 단위 병합**한다. 누락 키는 기본값으로 채워진다.
> 최상위 `_comment` 등 스키마에 없는 키는 무시된다.

---

## 1. `camera` — 카메라(Unity 시뮬레이터 + 실 PTZ) REST

`CameraClient` 가 사용. Unity `CWebCamCtrlServer`(또는 동일 인터페이스의 실 PTZ 어댑터) 호출.

| 키 | 타입 | 기본값 | 의미 |
|----|------|--------|------|
| `baseUrl` | URL | `http://localhost:13100` | 카메라 REST 서버 주소. `/health`,`/req_img`,`/req_move` 호출 기준 |
| `imageTimeoutMs` | int>0 | `7000` | `/req_img`(캡처) 요청 타임아웃(ms). 캡처는 이동+렌더 포함이라 길게 |
| `moveTimeoutMs` | int>0 | `3000` | `/req_move`·`/health` 요청 타임아웃(ms) |
| `zoomMin` | number>0 | `1.0` | 줌 하한. `clampZoom` 으로 방어적 클램프 |
| `zoomMax` | number>0 | `36.0` | 줌 상한(Unity 사양과 동일) |

---

## 2. `vpd` — 차량 검출(da_vpd_api) REST

`VpdClient` 가 사용. 캡처 이미지에서 차량 bbox(픽셀)를 검출 → 정규화하여 ROI 산출에 사용.

실제 서버: `Sub/da_vpd_api` (FastAPI, `.env` HOST=0.0.0.0 **PORT=9081**, multipart 필드명 `file`).

| 키 | 타입 | 기본값 | 의미 |
|----|------|--------|------|
| `endpoint` | URL | `http://127.0.0.1:9081` | VPD 서버 호스트 주소(경로 제외). 원격이면 실제 호스트로 변경 |
| `detPath` | `/`로 시작 문자열 | `/vpd/api/v2/det/imgupload` | **검출 엔드포인트 경로**. 실제 호출 URL = `endpoint + detPath`. (세그멘테이션은 `/vpd/api/v2/seg/imgupload`) |
| `apiKeyEnv` | 문자열(선택) | `VPD_API_KEY` | API 키가 담긴 **환경변수 이름**. 값이 있으면 `x-api-key` 헤더로 전송 |
| `timeoutMs` | int>0 | `8000` | 검출 요청 타임아웃(ms) |
| `maxRetries` | int≥0 | `3` | 일시 오류(5xx/408/429/네트워크) 시 지수 백오프 재시도 횟수 |

> **`detPath` 를 분리한 이유**: 호스트(`endpoint`)와 API 경로를 독립 변경하기 위함.
> 예) 서버 이전 시 `endpoint` 만, API 버전 변경 시 `detPath` 만 수정.
> `apiKeyEnv` 는 키 "값"이 아니라 키가 담긴 "환경변수 이름"이다(설정 파일에 비밀값 미저장).

---

## 2-1. `lpd` — 번호판 검출(da_lpd_api) REST (ActionAgent 용 참조)

SettingAgent 는 사용하지 않으나 실 서버 사양을 정확히 보관(ActionAgent 가 사용 예정).
실제 서버: `Sub/da_lpd_api` (FastAPI, `.env` HOST=0.0.0.0 **PORT=9082**, multipart 필드명 `file`).

| 키 | 타입 | 기본값 | 의미 |
|----|------|--------|------|
| `endpoint` | URL | `http://127.0.0.1:9082` | LPD 서버 호스트 주소 |
| `detPath` | `/`로 시작 문자열 | `/lpd/api/v1/imgupload` | 번호판 검출 경로. 결과 이미지 다운로드는 `/lpd/api/v1/resp/img_{id}` |
| `apiKeyEnv` | 문자열(선택) | `LPD_API_KEY` | API 키 환경변수 이름 |
| `timeoutMs` | int>0 | `8000` | 요청 타임아웃(ms) |
| `maxRetries` | int≥0 | `3` | 재시도 횟수 |

---

## 3. `setup` — 셋업 동작 파라미터

`SetupOrchestrator` / `RoiBuilder` / `RoiAccumulator` 가 사용.

| 키 | 타입 | 기본값 | 의미 |
|----|------|--------|------|
| `presetSettleMs` | int≥0 | `1000` | 각 프리셋 캡처 **전** 대기(ms). 실 PTZ 이동·정착 시간 확보 |
| `betweenPresetMs` | int≥0 | `500` | 프리셋 간 대기(ms). 연속 이동 부하 완화 |
| `minConfidence` | 0~1 | `0.5` | 이 신뢰도 미만의 VPD 검출은 슬롯에서 제외 |
| `roiPadding` | 0~1 | `0.05` | 검출 bbox 를 ROI 로 쓸 때 확장 비율(차량보다 약간 넓게) |
| `yBandTolerance` | 0~1 | `0.1` | 위치 정렬 시 "같은 행(밴드)"으로 묶는 중심 y 허용오차(정규화). 상→하/좌→우 정렬 기준 |
| `accumFrames` | int>0 | `1` | 프리셋당 캡처 프레임 수. **>1 이면 누적 클러스터링 모드**(실 PTZ 권장), `1`이면 단일 프레임(시뮬 강체) |
| `accumIntervalMs` | int≥0 | `1000` | 누적 모드에서 프레임 간 대기(ms) |
| `clusterDist` | 0~1 | `0.06` | 누적 클러스터링: 중심 거리 이 값 이내면 같은 슬롯으로 병합(정규화) |
| `clusterMinSupport` | int>0 | `1` | 슬롯으로 인정할 최소 관측 횟수(전이성/오검출 제거). 누적 모드에서 의미 |
| `lpdEnabled` | bool | `false` | 셋업 시 LPD 로 번호판 위치를 함께 검출해 슬롯에 저장(`plateRoiByPreset`). ActionAgent 센터라이징 prior. `lpd` 섹션 필요 |

> 시뮬레이터는 강체 배치라 `accumFrames=1` 로 충분. 실 PTZ 자동 ROI 는 `accumFrames>1` +
> `clusterDist`/`clusterMinSupport` 로 "검출 누적+클러스터링"을 수행(설계서 §8-1-1).

---

## 4. `map` — mapConfig 자동 프리셋 로딩 파일 경로

`/setup/run-from-map`, `npm run e2e` 가 사용. Unity CameraPos 내보내기에서 프리셋/PTZ 추출.

| 키 | 타입 | 기본값 | 의미 |
|----|------|--------|------|
| `cameraposFile` | 문자열 | `config/camerapos.json` | 카메라 뷰(=프리셋) 정의 파일. cam_id/preset_id/sname/pan/tilt/zoom 추출 |
| `presetFile` | 문자열(선택) | `config/preset.json` | 프리셋별 기대 주차면 개수(faceCount). 셋업 검출 수 **교차검증**에 사용(없으면 검증 생략) |

---

## 5. `server` — SettingAgent 자체 REST 서버

`buildServer`/`index.ts` 가 사용. "내가 여는 서버"의 설정(외부 주소 아님).

| 키 | 타입 | 기본값 | 의미 |
|----|------|--------|------|
| `port` | int>0 | `13020` | SettingAgent REST 수신 포트(`/health`,`/setup/*`,`/mapping`,`/brain/*`) |
| `apiKeyEnv` | 문자열(선택) | `SETTING_API_KEY` | (예약) 관리 API 보호용 키 환경변수 이름 |

---

## 6. `store` — 산출물 영속화 경로

`Repository` 가 사용.

| 키 | 타입 | 기본값 | 의미 |
|----|------|--------|------|
| `dataDir` | 문자열 | `data` | 셋업 산출물 저장 디렉터리. `setup_artifact.json` 이 여기에 생성 |
| `captureDir` | 문자열 | `data/captures` | (예약) 캡처 이미지 저장 디렉터리 |

---

## 7. 전체 예시 (현재 값)

```json
{
  "camera": { "baseUrl": "http://localhost:13100", "imageTimeoutMs": 7000, "moveTimeoutMs": 3000, "zoomMin": 1.0, "zoomMax": 36.0 },
  "vpd":    { "endpoint": "http://127.0.0.1:9081", "detPath": "/vpd/api/v2/det/imgupload", "apiKeyEnv": "VPD_API_KEY", "timeoutMs": 8000, "maxRetries": 3 },
  "lpd":    { "endpoint": "http://127.0.0.1:9082", "detPath": "/lpd/api/v1/imgupload", "apiKeyEnv": "LPD_API_KEY", "timeoutMs": 8000, "maxRetries": 3 },
  "setup":  { "presetSettleMs": 1000, "betweenPresetMs": 500, "minConfidence": 0.5, "roiPadding": 0.05, "yBandTolerance": 0.1,
              "accumFrames": 1, "accumIntervalMs": 1000, "clusterDist": 0.06, "clusterMinSupport": 1 },
  "map":    { "cameraposFile": "config/camerapos.json", "presetFile": "config/preset.json" },
  "server": { "port": 13020, "apiKeyEnv": "SETTING_API_KEY" },
  "store":  { "dataDir": "data", "captureDir": "data/captures" }
}
```

> 참고: LLM 두뇌·MCP·단계별 프롬프트 설정은 `llm.config.json`(별도 파일)에 있다. 두 파일은 역할이 분리되어 있다.
