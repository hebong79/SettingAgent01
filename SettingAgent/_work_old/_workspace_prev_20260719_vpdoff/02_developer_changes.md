# 02 구현 변경 — VPD 자동검출 정지 + VPD 테스트 버튼 분리

작성: 구현자(developer) · 2026-07-19 · 대상: SettingAgent
입력: `_workspace/01_architect_plan.md`(설계 확정안) · 기존 코드

---

## 0. 요약

설계서 §3 S1~S5 를 **그대로** 구현했다. 레이어 분리(라이브러리 기본 `true` / 라우트·UI 기본 `false`) 준수.
센터링·discovery·Finalizer·Aggregator·onPlaceFilter 는 **무접촉**.

- `npx tsc --noEmit`: **통과**(에러 0).
- `npx vitest run`: **1901 passed / 170 files**(기존 1888 → 회귀 0 + 신규 13).
- VPD off 시 `vpd.detect` 스파이 **0회**, on 시 호출, F10 우회를 유닛으로 봉인(수치 §4).

---

## 1. 변경 파일 목록

| # | 파일 | 종류 | 요지 |
|---|------|------|------|
| 1 | `src/capture/CaptureJob.ts` | 수정 | 라운드 VPD 게이트(`vpdEnabled`). vpd.detect·cuboid seg 미호출. status 노출 |
| 2 | `src/capture/types.ts` | 수정 | `CaptureStatus.vpdEnabled?: boolean` 추가 |
| 3 | `src/capture/detectPipeline.ts` | 수정 | 라이브 검출 VPD 게이트(`args.vpdEnabled`). summary.vpdEnabled 추가 |
| 4 | `src/api/captureRoutes.ts` | 수정 | Start/Detect 스키마 `vpdEnabled?` + **라우트 기본 false**(제품 정책) 배선 |
| 5 | `src/pipeline/SetupPipeline.ts` | 수정 | F10 가드 VPD 인지(`runVpdEnabled`). VPD off → dets 가드 우회(결정 E) |
| 6 | `web/index.html` | 수정 | `#cap-detect-run` title 갱신 + `#cap-vpd-test` 버튼 신설 |
| 7 | `web/app.js` | 수정 | `runLiveDetect(vpdEnabled)` · capStart `vpdEnabled:false` 고정 · 버튼 바인딩 · 상태 배지 |
| 8 | `test/captureJobVpdOff.test.ts` | **신규** | 라운드 VPD off/on 게이트(스파이 0/1) |
| 9 | `test/detectPipeline.test.ts` | 수정 | VPD 게이트 케이스 +2 · summary toEqual 2건에 `vpdEnabled` 반영 |
| 10 | `test/captureRoutes.test.ts` | 수정 | 라우트 VPD 게이트 +4 · 기존 VPD 거동 테스트 4건 `vpdEnabled:true` 주입/기대치 갱신 |
| 11 | `test/setupPipeline.test.ts` | 수정 | F10 VPD 인지 가드 +2 |

---

## 2. 핵심 구현 노트 (게이트·필터 전환·F10)

### S1. CaptureJob 라운드 게이트
- 필드 `private vpdEnabled = true;`, `start()`에서 `this.vpdEnabled = p.vpdEnabled ?? true;`(라이브러리 기본 true).
- `captureTarget()`:
  - `const raw = this.vpdEnabled ? await this.deps.vpd.detect(cap.jpg) : [];`
  - `const vehicles = this.vpdEnabled && this.vpdOnParkingOnly ? await this.applyOnPlaceFilter(raw, t) : raw;`
  - **플레이트 필터 라인(:386) 무변경** — `applyPlateFilter(rawPlates, [], t)` 로 결정 C 자동 성립(폴리곤 직접 필터, vehicles 결박 없음).
- cuboid 블록 게이트: `if (this.deps.cuboidCtx && this.vpdEnabled)` → VPD off 시 seg 문맥 미호출.
- `getStatus()`에 `vpdEnabled`(runId 있을 때) 추가 — 강등 위장 금지.

### S2. runDetect 라이브 게이트
- `args: { cam, preset, vpdEnabled? }`, 내부 `const vpdEnabled = args.vpdEnabled ?? true;`.
- `const rawVehicles = vpdEnabled ? await deps.vpd.detect(base.jpg) : [];`.
- cuboid 조건 `if (cuboidCtx && vpdEnabled && deps.vpd.segment && deps.vpd.canSegment)`.
- 매칭·zoom 재시도·onPlace 필터는 `vehicles=[]` 로 자연 스킵/폴리곤 직접(코드 변경 0).
- `summary.vpdEnabled: boolean` 추가(0대와 "미실행" 구분 — 정직 표기).

### S3. captureRoutes 제품 정책 기본 OFF
- `StartBodySchema`·`DetectBodySchema`에 `vpdEnabled: z.boolean().optional()`.
- `job.start({... vpdEnabled: parsed.data.vpdEnabled ?? false })`.
- `deps.pipeline?.onCaptureStart(autoChain ?? false, parsed.data.vpdEnabled ?? false)`.
- `runDetect({...}, { cam, preset, vpdEnabled: parsed.data.vpdEnabled ?? false }, ...)`.

### S4. SetupPipeline F10 VPD 인지(결정 E)
- 필드 `private runVpdEnabled = true;`, `onCaptureStart(armed, vpdEnabled = true)`에서 저장(기본 true → 기존 호출부 무수정).
- 가드: `if (this.runVpdEnabled && snapshot.dets.length === 0) { this.fail(...); return; }`.
  - VPD off 흐름은 우회 → finalize 진행(slot_setup 행 + `slot3d_front_center` 부트스트랩). hit 없으면 검출 컬럼 prev 보존이라 안전.

### S5. web UI 버튼 분리
- `#cap-detect-run`: LPD 전용(`runLiveDetect(false)`), title "번호판(LPD) 검출 — VPD 미실행".
- `#cap-vpd-test`(신설): `runLiveDetect(true)` — vehicles + 육면체 표시.
- `runLiveDetect(vpdEnabled = false)`: 바디에 `vpdEnabled` 추가. summary 메시지는 `s.vpdEnabled === false` 면 "VPD 미실행"으로 표기(차량 0/0 오해 방지).
- `capStart` 바디에 `vpdEnabled: false` 고정(체크박스 없음 — 마스터 확정).
- 캡처 폴링의 자동 검출(`runLiveDetect()` @app.js:1866)은 기본값 false 유지 → 자동 경로도 LPD 전용(제품 정책 일관).
- 상태 렌더: `status.vpdEnabled === false` 면 "VPD 미실행(번호판 전용)" 배지.
- 오버레이(`drawDetectOverlay`) **무변경** — vehicles=[] 면 차량 박스 자동 미표시.

---

## 3. 설계 결함/이슈 (명시)

### [이슈-1] "기존 vitest 무수정 통과" 전제는 summary/route 거동 변경으로 **부분 성립하지 않음** — 6건 갱신 필요
설계서 §8은 "라이브러리 기본 true → 기존 vitest 무수정 통과"를 회귀 0 근거로 들었으나, 실측 결과 **6건이 실패**했다. 원인은 두 가지이며 모두 설계 **의도된** 변경의 직접 결과다(코드 결함 아님):

1. **summary 필드 추가(exact-match 깨짐)**: `runDetect` summary 에 `vpdEnabled` 를 더하면서 `toEqual`(정확일치) 단언 3건이 깨졌다 — 기본값과 무관하게 필드가 하나 늘면 정확일치는 실패한다. 갱신: 기대 객체에 `vpdEnabled` 추가.
   - `detectPipeline.test.ts:120`(기본 true), `:427`(§6-15b, 기본 true), `captureRoutes.test.ts:527`(라우트 기본 false).
2. **라우트 기본 false 로 VPD 거동 변경**: 라우트 기본이 false 가 되면서, VPD 필터 거동을 검증하던 route 테스트가 vehicles=0 으로 깨졌다. 설계서 §8의 "라우트 경유 테스트만 `vpdEnabled:true` 주입" 지침을 그대로 적용.
   - `captureRoutes.test.ts` §6-17/§6-18/§6-18b → payload 에 `vpdEnabled:true` 주입(원 의도 보존).

→ **결론**: 회귀는 0(거동은 설계 그대로)이나, 설계서의 "무수정" 문구는 정확히는 "**라이브러리 직접 호출 + 스텁이 `{detect}` 만 구현한 테스트**"에 한한다. summary exact-match 와 route 경유 VPD 테스트는 갱신이 필수였다. documenter/qa 참고.

### [비고] 미세 정직 갭(설계서 §6.1 그대로, 수정 안 함)
VPD off + `vpdOnParkingOnly` + 폴리곤 부재 시 플레이트 필터 강등은 warn 미노출(차량 필터 미실행). 기능 안전(전량 통과). 범위 밖.

---

## 4. 자체 검증 결과 (수치)

### tsc
`npx tsc --noEmit` → **에러 0**.

### vitest
`npx vitest run` → **170 files · 1901 tests · 0 failed**(기존 1888 → +13 신규, 회귀 0).

신규/갱신 테스트가 봉인한 성공 기준(설계서 §0):

| 검증 항목 | 테스트 | 관측 |
|-----------|--------|------|
| 라운드 VPD off → `vpd.detect` 0회 | `captureJobVpdOff.test.ts` | `vpdDetect` 호출 **0**, `lpdDetect` **1**, plate det **1** 누적 |
| 라운드 VPD off → cuboid seg 0회 | 〃 | `cuboidCtx` 스파이 **0** |
| 라운드 VPD on/미지정 → 호출 | 〃 | `vpdDetect` **1**, vehicle det **1** |
| status.vpdEnabled 노출 | 〃 | `false` 관측 |
| runDetect VPD off → vpd.detect 0 · plates 반환 | `detectPipeline.test.ts` | `vpd.detect` **0**, plates **1**, `summary.vpdEnabled=false`, vpdCount **0** |
| runDetect 미지정 → 기본 true | 〃 | `vpd.detect` **1**, `summary.vpdEnabled=true` |
| POST /capture/detect 기본 → vpd.detect 0 | `captureRoutes.test.ts §6-19` | 스파이 **0**, vehicles **0**, `summary.vpdEnabled=false` |
| POST /capture/detect {vpdEnabled:true} → 호출 | `§6-19b` | 스파이 **1**, vehicles **1** |
| POST /capture/start 기본 → job.start(vpdEnabled:false) | `§6-16d` | `objectContaining({vpdEnabled:false})`, status.vpdEnabled=false |
| POST /capture/start {vpdEnabled:true} | `§6-16e` | vpdEnabled:true 전달 |
| F10 우회: VPD off + dets 0 → finalize 진행 | `setupPipeline.test.ts T4` | `finalize` 호출 **1**, stage ≠ failed |
| F10 유지: VPD on + dets 0 → finalize 미호출 | 〃 | `finalize` **0**, failed{finalize} |

> node 별도 스모크 대신 위 vitest 스파이가 동일 목적을 **결정적으로** 충족한다(vpd.detect 0/1 · F10 우회 실측).

---

## 5. QA 전달 테스트 포인트

- **회귀 0 재확인**: 센터링(`PtzCalibrator`/`platePtz`)·discovery(`PlateDiscoveryJob`)·Finalizer·Aggregator·onPlaceFilter 무접촉 — 관련 스위트 그대로 통과 확인.
- **레이어 규칙 경계면**: 라이브러리 기본 true / 라우트·UI 기본 false 가 어긋나지 않는지(라우트 테스트 §6-16d/§6-19 가 봉인).
- **라이브(리더) 확인 권장**:
  - "검출 실행" → 응답 vehicles 없음(LPD만), 오버레이 차량 박스 없음, cap-msg "VPD 미실행".
  - "VPD 검출(테스트)" → vehicles + 플레이트(+육면체) 표시.
  - 정밀수집 시작 → status.vpdEnabled=false 배지, 라운드 로그에 vpd 호출 없음.
- **F10 부트스트랩(중요)**: VPD off + autoChain 흐름에서 finalize 가 slot_setup 행 + `slot3d_front_center` 를 기록하는지(하류 discovery→센터링 부트스트랩 성립). 검출 컬럼은 prev 보존/null(파괴 아님).
- **문서화 인계**: setup_artifact.json 빈 slots 소비처(GET /mapping 등) 교차확인(설계서 §7-3).
