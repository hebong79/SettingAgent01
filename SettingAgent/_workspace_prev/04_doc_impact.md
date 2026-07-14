# 04 · 영향도 분석 — 리얼/시뮬 카메라 선택(cameraMode)

- 작성일: 2026-07-13 00:14:12
- 대상: SettingAgent
- 상세 문서: `docs/20260713_001412_카메라모드_리얼시뮬선택.md`

## 1. 변경 파일

| 파일 | 성격 | 변경 |
|------|------|------|
| `src/config/toolsConfig.ts` | 스키마/로더 | `cameraMode` enum + `realCamera?` 추가, DEFAULT 반영, loadToolsConfig 스칼라 병합 가드 + realCamera 특례 |
| `src/viewer/sourceRegistry.ts` | 부트스트랩 조립 | 입력 `Pick` 확장, 3분기 구현 |
| `config/tools.config.json` | 설정값 | `"cameraMode": "simulator"` |
| `test/cameraMode.test.ts` | 신규 테스트 | 16 케이스 |
| `test/sourceRegistry.test.ts`, `test/viewerEnabled.test.ts`, `test/mappingDirect.test.ts`, `test/mappingPut.test.ts` | 테스트 정합 | 시그니처 인자 추가 |

## 2. 의존성 그래프 전파

### 2-1. buildSourceRegistry 시그니처 확장
- 호출부는 `src/index.ts:71` 한 곳(`buildSourceRegistry(tools)` — 전체 tools 전달). `Pick` 에 `cameraMode`/`realCamera` 를 추가해도 tools 가 이미 두 필드를 가지므로 **호출부 무변경**.
- 그러나 테스트 4곳(`sourceRegistry`/`viewerEnabled`/`mappingDirect`/`mappingPut`)은 `buildSourceRegistry(...)` 에 인라인 부분객체를 넘겨 컴파일러가 새 필드를 요구 → 4개 테스트에 `cameraMode:'simulator', realCamera:undefined` 추가로 정합(구현자 반영, tsc 통과).
- **결론**: 시그니처 전파는 테스트에만 국한. 프로덕션 배선 무변경.

### 2-2. 병합 가드 → 전체 config 로드 경로
- `loadToolsConfig` 는 서버 부트스트랩(`index.ts`)에서 모든 SettingAgent 실행 경로가 거치는 단일 진입점. 병합 루프 수정은 **모든 섹션 로드에 영향**.
- 가드는 "객체(비배열)일 때만 스프레드"로, 기존 top-level 섹션은 전부 객체 → 병합 결과 불변. 스칼라/옵셔널만 신규 처리.
- QA 회귀 테스트로 **무회귀 확인**: `camera` 섹션 부분 병합(누락 키 DEFAULT 보강, `zoomMax` 확인) 유지 + `cameraMode:'real'` 문자열 미파손. 전체 1254 통과.
- **리스크 평가**: 단일 로더 수정이라 범위가 넓어 보이나, 동작 변화는 신규 스칼라/옵셔널에 한정되고 객체 섹션은 증명상 불변. 낮음.

### 2-3. registry keys → health → 프론트 sel-source
- `buildSourceRegistry` 출력 `Map.keys()` → `GET /viewer/api/health` `sources` → 프론트 `loadSources()` → `sel-source` 드롭다운 + `state.source = data.sources[0]`.
- simulator=`['rpc']`(기존과 동일), real=`[realCamera.id]`. 단일 소스라 첫 항목 자동 선택 → **프론트 코드 무변경**.
- 기존 `viewerEnabled.test.ts` 가 `sources:['rpc']` 를 이미 검증 → 시뮬 경로 무회귀 간접 확인.

## 3. 정밀수집 RpcCameraClient 불일치 (핵심 · 후속)

- `setup/run`·`capture`·`calibrate`·`finalize` 는 `index.ts` 에서 생성·주입되는 `RpcCameraClient`(Unity RPC 13110)를 사용. **cameraMode 와 완전히 분리**되어 있고 이 변경이 건드리지 않는다.
- 따라서 cameraMode='real' 은 **뷰어 라이브 소스만** 리얼로 바꾸고, 정밀수집/검출 파이프라인은 여전히 13110 Unity RPC 를 탄다.
- 파급: 리얼 카메라로 정밀수집을 하려면 `RpcCameraClient` ↔ `RealPtzSource` 통합(공통 리얼 `ICameraClient` 구현체)이 별도로 필요 → **후속 과제**. 실기기 미확인으로 지금 구현하면 검증 불가한 추측성 코드.

## 4. 리스크

- **리얼 스텁 미검증**: `RealPtzSource` CGI 경로/PTZ 범위는 실기기(HNR-2036LA, 192.168.0.153) 가정값. cameraMode='real' 로 선택은 되지만 실통신은 미보증(유닛은 인스턴스/id/kind 정합까지만). 실기 스모크 전까지 리얼 라이브는 "선택 가능" 수준.
- **fail-fast throw**: cameraMode='real' + realCamera 누락 시 부트스트랩 throw. 의도된 오설정 노출이나, 운영자가 realCamera 를 빠뜨리면 서버가 기동하지 않음 → 사용법 문서로 완화.
- **cameraSources vs cameraMode 혼용**: 둘 다 설정 시 cameraSources 우선(cameraMode 무시). 운영자 혼선 가능 → 문서에 precedence 명시.

## 5. 무영향 확인

- `CameraposSource`/`RpcCameraSource`/`CRpcClient`/`CameraClient`: simulator 경로가 기존 폴백과 동일(id='rpc') → 무영향.
- `RealPtzSource`: 로직 무변경(선택 가능해질 뿐).
- `SimulatorSource`(cameraSources 'sim' 경로): 무변경.
- REST 계약(health/cameras/move/stream 등): 스키마 변경 없음. 값만 모드에 따라 달라짐.

## 6. 후속 과제

- 리얼 정밀수집 경로(RpcCameraClient ↔ RealPtzSource 통합, 리얼 ICameraClient 구현체) — 실기 확인 후 설계.
- RealPtzSource CGI 경로/PTZ 범위 실측 반영 + 실통신 스모크.
- (연계) 주차면 자동보정·센터라이징의 리얼 카메라 대응은 위 정밀수집 통합에 종속.

## 7. 확인 필요 (불확실)

- 실기기 HNR-2036LA CGI 스펙(로그인 경로/스냅샷 URL/PTZ 범위) — 미확인. 리얼 라이브 실동작 여부는 실기 스모크 전까지 단정 불가.
