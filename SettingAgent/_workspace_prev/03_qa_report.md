# 03 · QA 검증 리포트 — 리얼/시뮬 카메라 선택(cameraMode)

설계서 §6 / 구현내역 02 기준. vitest 유닛테스트 작성·실행 완료. **모든 테스트 통과, 구현 결함 없음.**

## 1. 실행 결과 (종합)

| 항목 | 명령 | 결과 |
|------|------|------|
| 신규 테스트 | `npx vitest run test/cameraMode.test.ts` | ✅ 16/16 통과 |
| 전체 회귀 | `npx vitest run` | ✅ **1254/1254 통과** (118 파일) |
| 타입체크 | `npx tsc --noEmit` | ✅ 에러 0 |

신규 파일: `SettingAgent/test/cameraMode.test.ts` (16 케이스).

## 2. 신규 테스트 목록 (설계서 §6 매핑)

### (1) config 로드/기본값 — 6 케이스
- `cameraMode` 미지정 config 로드 → default `'simulator'` (§6-1).
- `DEFAULT_TOOLS_CONFIG.cameraMode === 'simulator'`, `realCamera` 미포함.
- 실제 `config/tools.config.json` → `'simulator'` 로드(리더 라이브 실증과 일치).
- 명시 `'real'` 로드 / 명시 `'simulator'` 로드.
- **잘못된 값(`'hucoms'`) → zod 파싱 throw(거부)** — enum 가드 검증.

### (2) 스칼라 병합 회귀 방지 (핵심) — 2 케이스 (§6-6)
- `cameraMode: 'real'` 지정 config 로드가 **문자-인덱스 객체로 깨지지 않고** 정확히 `'real'` 문자열로 파싱 → `loadToolsConfig` 스칼라 병합 가드 검증.
- 다른 스칼라 무회귀 + **객체 섹션(camera)은 여전히 부분 병합**(누락 키 DEFAULT 보강, `zoomMax` 확인) → 가드 추가가 기존 객체 병합 동작을 깨지 않음을 증명.

### (3) realCamera 통과 — 2 케이스
- `realCamera`(CameraSourceConfig 형태) 그대로 파싱(`id`/`kind`/`host`/`port`/`loginPath`).
- `realCamera.kind` enum 밖(`'bogus'`) → 파싱 throw.

### (4) buildSourceRegistry 분기 — 6 케이스 (§6-2~5)
- simulator(cameraSources 미설정) → `CameraposSource(id='rpc')` 1개, `.kind==='rpc'`.
- `cameraMode` undefined(런타임 방어) → simulator 폴백(real 로 새지 않음).
- real + realCamera 있음 → `RealPtzSource(id=realCamera.id)`, `.kind==='hucoms'`.
- real + realCamera.id 커스텀(`'ptz-front'`) → 해당 id 를 키로 사용.
- **real + realCamera 없음 → throw** (`'리얼 카메라(realCamera) 설정이 없습니다'` 메시지 일치, fail-fast).
- **precedence**: cameraSources 명시(길이>0) + cameraMode='real'(realCamera 없음) → cameraSources 우선(다중 sim+hucoms 등록), cameraMode 무시. real 분기였다면 throw 였을 상황에서 throw 안 함으로 우선순위 증명.

## 3. 경계면 교차 비교 (shape 정합 확인)

- **config JSON → zod 스키마**: `tools.config.json`의 `cameraMode` 스칼라가 `loadToolsConfig` 병합 루프(객체 스프레드)에서 문자열로 보존되는지 교차 확인. 가드(`typeof def==='object' && !Array` 일 때만 스프레드)로 스칼라는 값 대입 → 파싱 성공. 회귀 테스트로 고정.
- **sourceRegistry 출력 → health/sel-source 소비**: registry `keys()` 가 `/viewer/api/health` 의 `sources` 키가 되고 프론트 `sel-source` 를 채운다. simulator=`['rpc']`, real=`[realCamera.id]` 로 단일 소스 → 첫 항목 자동 선택. 기존 `viewerEnabled.test.ts`가 `sources:['rpc']` 를 이미 검증(무회귀 확인).
- **realCamera → RealPtzSource**: `{...realCamera, kind:'hucoms'}` 강제 후 생성자에 전달 → `.kind==='hucoms'` 인스턴스 확인. id 가 그대로 Map 키가 됨을 검증.

## 4. 발견 사항

- **구현 결함: 없음.** 병합 가드·3분기·fail-fast 모두 설계대로 동작.
- **테스트 결함 1건(자체 수정 완료)**: 초기 회귀 테스트에서 `cfg.cameraMode['0'] === undefined` 로 문자-인덱스 객체 여부를 검사했으나, JS 문자열은 인덱스 접근 가능한 primitive 라 `'real'['0'] === 'r'` 이므로 오탐 실패 발생. 해당 단정은 무의미하여 제거하고 `typeof === 'string'` + enum 동등 비교로 대체(가드가 깨졌다면 zod enum 파싱이 throw 하므로 파싱 성공 자체가 유효한 회귀 신호).

## 5. 커버리지 / 한계

**커버**: config 파싱·기본값·enum 거부, 스칼라 병합 가드(회귀), realCamera 통과, buildSourceRegistry 3분기(simulator/real/precedence)+throw.

**범위 밖(미검증 — 명시)**:
- **리얼 실기기 연동 스모크**: HNR-2036LA(192.168.0.153) CGI 경로/PTZ 범위는 실기 미확인 가정값 → RealPtzSource 실통신 스모크 미수행(유닛은 인스턴스 생성·id/kind 정합까지만).
- **리얼 정밀수집/검출/캘리브레이션 경로**: `RpcCameraClient`(Unity RPC 13110)를 계속 사용하며 cameraMode 로 전환되지 않음(설계 §3 한계). 뷰어 라이브 소스 선택에 한정. 실기 정밀수집은 후속 과제.
- 프론트 `sel-source` DOM 렌더는 health 키 자동 구성으로 코드 무변경 → 별도 UI 테스트 불필요(기존 viewerEnabled 로 간접 확인).

## 6. 결론

설계 §6 성공 기준 6개 항목 전부 유닛테스트로 검증·통과. 전체 1254 테스트 무회귀, tsc 통과. **문서화 단계 진행 가능.**
