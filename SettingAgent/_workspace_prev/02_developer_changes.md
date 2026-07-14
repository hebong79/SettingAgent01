# 02 · 구현 변경 내역 — 리얼/시뮬 카메라 선택 (config + 재시작)

설계서 `01_architect_plan.md` 준수. 최소·외과적 구현. 디폴트 = 시뮬레이터.

## 변경 파일 목록
| 파일 | 변경 요지 |
|------|----------|
| `src/config/toolsConfig.ts` | `cameraMode` enum(default `'simulator'`) + `realCamera?` 필드 추가, DEFAULT 반영, **loadToolsConfig 스칼라 병합 가드** + realCamera 특례 통과 |
| `src/viewer/sourceRegistry.ts` | 입력 `Pick` 에 `cameraMode`·`realCamera` 추가, §2-2 3분기 구현 |
| `config/tools.config.json` | `"cameraMode": "simulator"` 추가 |
| `test/sourceRegistry.test.ts` | `RegistryCfg` 타입·`base()` 에 `cameraMode`,`realCamera` 반영(컴파일 정합) |
| `test/viewerEnabled.test.ts` / `test/mappingDirect.test.ts` / `test/mappingPut.test.ts` | 인라인 `buildSourceRegistry(...)` 호출에 `cameraMode:'simulator', realCamera:undefined` 추가(시그니처 정합) |

`src/index.ts` 는 `buildSourceRegistry(tools)` 로 전체 tools 전달 → **호출부 무변경**. RpcCameraClient 배선(setup/capture/calibrate/finalize) **손대지 않음**.

## config 스키마 (신규)
```ts
// ToolsConfigSchema 내부
cameraMode: z.enum(['simulator', 'real']).default('simulator'),
realCamera: CameraSourceConfigSchema.optional(),
```
- `DEFAULT_TOOLS_CONFIG.cameraMode = 'simulator'`. `realCamera` 는 DEFAULT 미포함(옵셔널).
- `realCamera` 는 기존 `CameraSourceConfig` 형태 재사용(`{id, kind, host?, port?, loginPath?, snapshotUrl?, ptz?}`). 자격증명 미포함(UI 세션).
- 리얼 전환 시 `config/tools.config.json` 예시:
  ```json
  "cameraMode": "real",
  "realCamera": { "id": "real", "kind": "hucoms", "host": "192.168.0.153", "port": 80 }
  ```
  (스키마상 `kind` 필수 — 파싱 시 `"hucoms"` 명시 필요. sourceRegistry 는 내부에서 `hucoms` 로 강제.)

## 병합 가드 (중요 · 회귀 방지)
기존 `loadToolsConfig` 병합 루프는 모든 섹션을 `{...DEFAULT[key], ...raw[key]}`(객체 스프레드)로 병합했다. 스칼라 `cameraMode`('simulator')를 스프레드하면 문자-인덱스 객체(`{0:'s',1:'i',...}`)로 깨져 zod 파싱이 실패한다.

수정: `def` 가 **객체(비배열)** 일 때만 스프레드, 스칼라는 `raw[key] ?? def` 로 값 대입.
```ts
const def = DEFAULT_TOOLS_CONFIG[key];
if (def !== null && typeof def === 'object' && !Array.isArray(def)) {
  merged[key] = { ...(def as Record<string, unknown>), ...((raw[key] as Record<string, unknown>) ?? {}) };
} else {
  merged[key] = raw[key] ?? def;
}
```
- 기존 섹션은 전부 객체 → 병합 동작 불변(회귀 없음).
- `raw` 타입을 `Record<string, unknown>` 로 완화(스칼라 값 수용).
- `realCamera` 는 `cameraSources` 와 동일 특례: `if (raw.realCamera !== undefined) merged.realCamera = raw.realCamera;`

## buildSourceRegistry 분기 (precedence: cameraSources > cameraMode)
1. **(A)** `cfg.cameraSources?.length > 0` → 기존 다중 sim/hucoms 경로 그대로(하위호환, cameraMode 무시).
2. **(B) real** → `realCamera` 없으면 `throw new Error('리얼 카메라(realCamera) 설정이 없습니다')`(fail-fast). 있으면 `{...realCamera, kind:'hucoms'}` 로 `RealPtzSource(rc, camera.imageTimeoutMs)` 등록(id=`realCamera.id`).
3. **(simulator, 기본)** → 현재 폴백 `CameraposSource(id='rpc')` 그대로(CRpcClient + RpcCameraSource + CameraClient 합성).

## 타입체크
`npx tsc --noEmit` **통과**(에러 0).

## 유닛테스트 후보 (qa 단계)
설계서 §6 기준:
1. `cameraMode` 기본값 = 'simulator'(미기재 파싱).
2. simulator → `keys=['rpc']`, `CameraposSource` instanceof(기존 케이스 유지).
3. real + realCamera → `keys=[realCamera.id]`, `RealPtzSource` instanceof, `.kind==='hucoms'`.
4. real + realCamera 미지정 → `buildSourceRegistry` throw('리얼 카메라(realCamera) 설정이 없습니다').
5. cameraSources(길이>0) + cameraMode='real' → cameraSources 우선(다중 케이스, cameraMode 무시).
6. `loadToolsConfig` 스칼라 병합 → `cameraMode:'real'` 문자열이 안 깨지고 로드(회귀 방지).

## 한계 (문서화 전달 — 범위 밖)
- 리얼 모드에서 **뷰어 라이브 소스만** Hucoms(RealPtzSource, CGI)로 전환된다.
- **정밀수집/검출/캘리브레이션/파이널라이즈** 경로는 `RpcCameraClient`(Unity RPC 13110)를 계속 사용 → cameraMode 와 무관. 실기 정밀수집은 미지원(후속 과제). RealPtzSource 는 실기기(192.168.0.153, HNR-2036LA) 미확인 스텁이므로 로직 무변경.
- 프론트 `sel-source` 는 `/viewer/api/health` 의 `sources` 키로 자동 구성 → 코드 무변경. real 시 표시명 = `realCamera.id`.
