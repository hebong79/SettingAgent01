# 01 · 설계 계획 — SettingAgent 리얼/시뮬 카메라 선택 (config 기반)

## 0. 요청 요약
- **목표**: SettingAgent 뷰어 카메라 소스를 **설정으로 리얼(Hucoms PTZ) / 시뮬레이터(Unity RPC) 중 선택**. 디폴트 = 시뮬레이터.
- **제약**: 최소·외과적. 카메라 1대 현황 → 과설계 금지. 리얼은 실기기 미확인 스텁(선택 가능하게만).
- **실행 방식**: **config + 재시작** (런타임 전환 아님). 리더 기본 권고 채택.

---

## 1. 현황 실측 정리 (근거)
- `src/index.ts:71` — `const sources = tools.viewer.enabled ? buildSourceRegistry(tools) : undefined;` (뷰어 소스 레지스트리 조립 지점).
- `src/viewer/sourceRegistry.ts` — `buildSourceRegistry(cfg: Pick<ToolsConfig,'camera'|'cameraSources'|'unityRpc'|'map'>)`:
  - `cameraSources` 미설정/빈 배열 → **폴백**: `CameraposSource(id='rpc')` = 시뮬(Unity 13110 RPC + camerapos.json). ← **현재 동작**.
  - `cameraSources` 설정 시 → 항목별 `kind:'sim'`(`SimulatorSource`, 죽은 13100 REST) / `'hucoms'`(`RealPtzSource`).
- `src/config/toolsConfig.ts` — `CameraSourceConfigSchema{id,kind,baseUrl?,host?,port?,loginPath?,snapshotUrl?,ptz?}`(152), `cameraSources?: []`(230). `camera.baseUrl`·`unityRpc.baseUrl` = 13110.
- `src/viewer/RealPtzSource.ts` — Hucoms CGI 어댑터. **경로/PTZ 범위 실기기 미확인 가정값**. `listCameras`는 프리셋 없는 라이브 1개. 자격증명은 config 아닌 UI 세션(`login()`)로 통과.
- `src/viewer/routes.ts:377` — `/viewer/api/health → { sources: [...sources.keys()] }`. 프론트 `web/app.js` `loadSources()`(219) 가 이 목록으로 `sel-source` 드롭다운을 채우고 `state.source = data.sources[0]`.
- **정밀수집·검출·캘리브레이션 경로**: `src/index.ts:33` `camera = new RpcCameraClient(...)`(13110 RPC) 를 `SetupOrchestrator`/`CaptureJob`/`Finalizer`/`PtzCalibrator` 에 주입. **뷰어 소스와 완전히 분리**되어 있고 cameraMode 로 전환되지 않는다.

---

## 2. 설계 결정

### 2-1. config 필드 (신규)
`ToolsConfigSchema` 에 다음 2개 추가:

```
// 뷰어 카메라 소스 선택. cameraSources(다중/고급) 미설정 시 이 값으로 단일 소스 구성.
cameraMode: z.enum(['simulator','real']).default('simulator'),
// 리얼(Hucoms) 카메라 접속정보. cameraMode='real' 일 때 필요(자격증명은 미포함 — UI 세션).
realCamera: CameraSourceConfigSchema.optional(),
```
- `DEFAULT_TOOLS_CONFIG` 에 `cameraMode: 'simulator'` 추가. `realCamera` 는 `cameraSources` 와 동일하게 DEFAULT 미포함(옵셔널).
- `config/tools.config.json` 에 `"cameraMode": "simulator"` 명시(디폴트 가시화). `realCamera` 는 미기재(문서에 예시 형태 제공, 리얼 전환 시 사용자가 추가).

### 2-2. buildSourceRegistry 분기 (핵심)
입력 타입에 `cameraMode`·`realCamera` 추가:
`Pick<ToolsConfig,'camera'|'cameraSources'|'unityRpc'|'map'|'cameraMode'|'realCamera'>`

의사코드:
```
export function buildSourceRegistry(cfg): Map<string,CameraSource> {
  const sources = new Map();

  // (A) 고급/다중: cameraSources 명시(길이>0) → 기존 경로 그대로(하위호환 유지). cameraMode 무시.
  if (cfg.cameraSources && cfg.cameraSources.length > 0) {
    for (const src of cfg.cameraSources) { ...기존 sim/hucoms 분기 그대로... }
    return sources;
  }

  // (B) 단일 소스: cameraMode 로 선택(cameraSources 미설정/빈배열).
  if (cfg.cameraMode === 'real') {
    if (!cfg.realCamera) throw new Error("cameraMode='real' 에는 realCamera 설정이 필요합니다");
    const rc = { ...cfg.realCamera, kind: 'hucoms' as const };
    sources.set(rc.id, new RealPtzSource(rc, cfg.camera.imageTimeoutMs));
    return sources;
  }

  // 'simulator'(기본) → 현재 폴백(CameraposSource, id='rpc') 그대로.
  const rpc = new CRpcClient(cfg.unityRpc);
  const inner = new RpcCameraSource(rpc, new CameraClient(cfg.camera));
  sources.set('rpc', new CameraposSource(cfg.map.cameraposFile, inner, rpc));
  return sources;
}
```

**결정 근거**
- **precedence**: `cameraSources`(명시) > `cameraMode`. cameraSources 는 다중/고급용으로 보존(기존 테스트·동작 무손상). 미설정 시에만 cameraMode 가 단일 소스를 결정 → 리더 권고와 일치.
- **simulator id='rpc' 유지**: 프론트 `sel-source`·기존 테스트·camerapos 시맨틱 하위호환. 재명명(sim) 안 함(외과적).
- **real id**: `realCamera.id`(예 `'real'`). health `sources` 키·`sel-source` 표시명이 됨.
- **real 미설정 시 throw**: 리얼은 opt-in·미검증. 조용한 폴백 대신 **fail-fast**(기동 시 명확한 config 에러)로 오설정을 드러냄(CLAUDE.md 1: 혼란 숨기지 않기).

### 2-3. 프론트(sel-source) 영향
- **코드 변경 없음**. `sel-source` 는 `/viewer/api/health` 의 `sources` 키로 자동 구성. simulator=`['rpc']`, real=`['real']`(realCamera.id). 단일 소스라 첫 항목 자동 선택 → 동작 유지.
- (선택, 범위 밖 권고) 옵션 탭에 현재 `cameraMode` **표시만**. 전환은 config+재시작이므로 웹 토글은 이번 범위 제외.

---

## 3. ⚠️ 리얼 모드 정밀수집/검출 불일치 (중요 · 한계 명시)
- `setup/run`·`capture`·`calibrate`·`finalize` 는 `RpcCameraClient`(13110 Unity RPC) 를 사용. **cameraMode 와 무관**하게 항상 13110 을 타겟.
- 따라서 **cameraMode='real' 이어도 정밀수집/검출 파이프라인은 여전히 Unity RPC(13110) 필요**. 리얼 카메라(RealPtzSource, CGI)로 자동 전환되지 않는다.
- **이번 범위 = "뷰어 라이브 소스 선택"에 한정.** 리얼 카메라 정밀수집 경로(RpcCameraClient ↔ RealPtzSource 통합, ICameraClient 리얼 구현체)는 **후속 과제**로 분리. 실기기(192.168.0.153, HNR-2036LA) 미확인이라 지금 구현하면 검증 불가한 추측성 코드가 됨(CLAUDE.md 2).
- **문서화 필수 항목**: "리얼 모드에서 뷰어 라이브는 Hucoms, 정밀수집/검출은 Unity RPC 13110 을 계속 사용 → 실기 정밀수집은 미지원(후속)". 사용자 오해 방지.

---

## 4. 변경 파일 (구현자 전달)
| 파일 | 변경 요지 |
|------|----------|
| `src/config/toolsConfig.ts` | `cameraMode` enum(default 'simulator') + `realCamera?` 필드 추가. `DEFAULT_TOOLS_CONFIG.cameraMode='simulator'`. **`loadToolsConfig` 병합 루프 주의**: 현재 루프가 모든 섹션을 `{...DEFAULT[key], ...raw[key]}`(객체 스프레드)로 병합 → 스칼라 `cameraMode` 를 스프레드하면 문자열이 문자 인덱스 객체로 깨짐. 스칼라는 스프레드 제외 처리 필요(가드: `typeof def==='object'&&!Array` 일 때만 스프레드, 아니면 `raw[key] ?? def`). `realCamera` 는 `cameraSources` 와 동일 특례(`if (raw.realCamera!==undefined) merged.realCamera=raw.realCamera`). |
| `src/viewer/sourceRegistry.ts` | 입력 `Pick` 에 `cameraMode`·`realCamera` 추가. §2-2 분기 구현. import 기존 유지(RealPtzSource 이미 import됨). |
| `config/tools.config.json` | `"cameraMode": "simulator"` 추가. |
| `test/sourceRegistry.test.ts` | RegistryCfg 타입·base()에 `cameraMode:'simulator'`,`realCamera:undefined` 반영 + 신규 케이스(§6). |
| `test/config.test.ts` | (해당 시) cameraMode 기본값·병합 케이스 보강. |
| `docs/*` (documenter) | 리얼/시뮬 선택 사용법 + realCamera 예시 형태 + §3 한계. |

- **미변경(주의)**: `index.ts` 는 `buildSourceRegistry(tools)` 로 전체 tools 전달 → 시그니처만 넓히면 호출부 무변경. `RpcCameraClient` 배선(setup/capture/calibrate) 절대 손대지 않음.

---

## 5. MCP 도구 vs LLM 두뇌 경계
- 본 기능은 **정적 config 배선(결정형)** — LLM 두뇌·MCP 도구 어느 쪽도 아님. 소스 선택은 부트스트랩 조립 로직. 판단·모호성 없음 → 두뇌 개입 불필요. 경계 위반 없음.

---

## 6. 유닛테스트 대상 (검증 기준)
1. `cameraMode` 기본값 = 'simulator' → 검증: config 미기재 파싱 시 'simulator'.
2. simulator(cameraSources 미설정) → 검증: `keys=['rpc']`, `CameraposSource` instanceof (기존 케이스 유지).
3. real + realCamera 지정 → 검증: `keys=[realCamera.id]`, `RealPtzSource` instanceof, `.kind==='hucoms'`.
4. real + realCamera 미지정 → 검증: `buildSourceRegistry` throw(명확 메시지).
5. cameraSources 명시(길이>0) + cameraMode='real' → 검증: cameraSources 가 이김(기존 다중 케이스 그대로, cameraMode 무시).
6. `loadToolsConfig` 스칼라 병합 → 검증: `cameraMode` 문자열이 깨지지 않고 'real' 로 로드(회귀 방지).

---

## 7. 영향도 분석
- **기존 폴백/CameraposSource/RpcCameraSource**: simulator 경로가 기존 폴백과 동일(id='rpc') → 무영향.
- **cameraSources(다중)**: precedence 로 그대로 우선 → 기존 테스트·동작 무손상.
- **RealPtzSource**: 스텁 그대로(경로/범위 실측 필요) — 선택 가능해질 뿐 로직 무변경.
- **프론트 sel-source**: health 키 자동 반영 → 코드 무변경. real 시 표시명 'real'.
- **RpcCameraClient(정밀수집)**: 무변경. §3 한계로 문서화.
- **`loadToolsConfig` 병합 루프**: 스칼라 가드 추가는 기존 객체 섹션 병합 동작 불변(회귀 테스트 6번으로 보증).
- **하위호환**: cameraMode 기본 simulator + cameraSources 우선 → 기존 배포·설정 파일 무수정 시 동작 동일.

---

## 8. 미해결 / 가정
- **가정 A**: 실행 방식은 config+재시작(런타임 전환 미구현). — 리더 권고 채택.
- **가정 B**: real 미설정 시 fail-fast(throw). 대안: simulator 로 조용히 폴백 → 채택 안 함(오설정 은폐). 리더 이견 시 조정 가능.
- **가정 C**: precedence = cameraSources > cameraMode. 리더 확인 요망(반대로 cameraMode 우선을 원하면 분기 순서만 교체).
- **미해결 1**: `realCamera` 를 별도 필드로 둘지 vs `cameraSources`(hucoms 1개) 재사용할지 — 본 계획은 **별도 `realCamera`**(단순 선택자와 고급 배열 분리). 리더 승인 시 확정.
- **미해결 2(범위 밖)**: 리얼 정밀수집 경로(§3) — 실기기 확인 후 별도 설계.
