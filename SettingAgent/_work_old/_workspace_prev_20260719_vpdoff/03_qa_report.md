# 03 검증 리포트 — VPD 자동검출 정지 + VPD 테스트 버튼 (독립 검증)

작성: 검증자(qa-tester) · 2026-07-19 · 대상: SettingAgent
입력: `_workspace/01_architect_plan.md`(설계) · `_workspace/02_developer_changes.md`(구현) · 변경 소스 전수 정독
방법: 개발자 테스트 품질 감사 + 경계면 교차 비교 + 자동 경로 잔존 VPD 코드 추적 + 전체 `npx vitest run` / `npx tsc --noEmit`

---

## 0. 최종 판정

**통과(회귀 0). 설계 성공 기준(§0) 전부 봉인 확인.** 소스 결함 없음. 보강 1건(runDetect seg 게이트) 추가.

| 항목 | 결과 |
|------|------|
| `npx tsc --noEmit` | **에러 0** |
| `npx vitest run` | **170 files · 1902 tests · 0 failed**(구현자 1901 + qa 보강 1) |
| 자동 경로 잔존 VPD 호출 | **0**(코드 추적 확정 — §3) |
| LPD 보존(vehicles=[] 폴리곤 직접) | **확인**(§4) |
| 갱신된 기존 6건 | **정당**(의도 변경 반영 — 거동 회귀 은닉 아님, §2) |

---

## 1. 개발자 테스트 품질 감사 (검증 항목 1)

각 성공 기준이 **실제로 봉인**되는지 스파이 대상·단언을 직접 확인했다.

| 성공 기준(설계 §0) | 봉인 테스트 | 스파이/단언 실측 | 판정 |
|--------------------|-------------|------------------|------|
| 라운드 VPD off → `vpd.detect` 0회 | `captureJobVpdOff.test.ts:99` | `vpdDetect` **toHaveBeenCalledTimes(0)** + vehicle det 0 | 견고 |
| 라운드 VPD off → cuboid seg 0회 | 〃 `:108` | `cuboidCtx` 스파이 **0회**(withCuboid 주입에도) | 견고 |
| 라운드 VPD off → LPD 계속 | 〃 `:100` | `lpdDetect` **1회** · plate det **1** 누적 | 견고 |
| 라운드 VPD on/미지정 → 호출 | 〃 `:113,119` | `vpdDetect` **1회** · vehicle det 1 | 견고 |
| status.vpdEnabled 노출 | 〃 `:124` | `getStatus().vpdEnabled === false` | 견고 |
| runDetect VPD off → detect 0·plates 반환 | `detectPipeline.test.ts:433` | `vpd.detect` **0회** · plates 1 · `summary.vpdEnabled=false` · vpdCount 0 | 견고 |
| runDetect 미지정 → 기본 true | 〃 `:447` | `vpd.detect` **1회** · vpdEnabled=true | 견고 |
| **runDetect VPD off → seg 0회** | 〃 `:457`(★ qa 보강) | `vpd.segment` **0회**(cuboidCtx·segment·canSegment 배선에도) · `cuboids` 키 없음 | **보강 후 견고** |
| 라우트 기본 → `vpd.detect` 0회 | `captureRoutes.test.ts:692`(§6-19) | `sv.vpdDetect` **0회** · vehicles 0 · vpdEnabled=false | 견고 |
| 라우트 `{vpdEnabled:true}` → 호출 | 〃 `:702`(§6-19b) | `sv.vpdDetect` **1회** · vehicles 1 | 견고 |
| start 기본 → `job.start(vpdEnabled:false)` | 〃 `:637`(§6-16d) | `objectContaining({vpdEnabled:false})` · status.vpdEnabled=false | 견고 |
| start `{vpdEnabled:true}` | 〃 `:646`(§6-16e) | vpdEnabled:true 전달 · status=true | 견고 |
| F10 우회: VPD off + dets 0 → finalize 진행 | `setupPipeline.test.ts:162`(T4) | `finalize` **1회** · stage ≠ failed | 견고 |
| F10 유지: VPD on + dets 0 → finalize 미호출 | 〃 `:172` | `finalize` **0회** · failed{finalize} | 견고 |

### 보강 내역 (허술 → 보강)
- **[보강-1] runDetect 육면체 seg 게이트 무검증**: 개발자 `detectPipeline` VPD 게이트 테스트는 `vpd.detect=0`만 봉인하고, 설계 §3 S2 가 명시한 "seg 호출도 스킵"(cuboid 게이트 `cuboidCtx && vpdEnabled && …`)은 검증하지 않았다. `cuboidCtx`를 주입한 케이스가 없어 게이트의 `vpdEnabled` 항이 실제로 seg를 막는지 미봉인.
  - **조치**: `detectPipeline.test.ts`에 케이스 추가(`:457`). `segment`(호출 시 throw 하는 스파이)·`canSegment`·`cuboidCtx`를 **모두 배선**한 상태에서 `vpdEnabled:false` → `vpd.segment` **0회** + 응답에 `cuboids` 키 없음을 단언. 게이트의 `vpdEnabled` 단락이 seg를 막음을 결정적으로 봉인. → 통과(해당 파일 35→36 tests).
  - 참고: CaptureJob 라운드 seg 게이트는 이미 `captureJobVpdOff.test.ts:108`이 봉인하므로 보강 불요.

그 외 개발자 테스트는 스파이 대상·단언이 성공 기준과 정확히 일치하며 허술한 곳 없음.

---

## 2. 갱신된 기존 6건 감사 — "의도 변경 반영" vs "거동 회귀 은닉" (검증 항목 2)

구현자 changes §3 [이슈-1]과 대조. **6건 전부 설계 의도(summary 필드 추가 / 라우트 기본 false)의 직접 결과**이며 거동 회귀를 숨긴 갱신이 아님을 확인.

### (a) summary `vpdEnabled` 필드 추가로 인한 `toEqual` 갱신 — 3건
`runDetect`가 `summary`에 `vpdEnabled`를 추가하면서 정확일치(`toEqual`) 단언이 필드 1개 증가로 깨진 것. **거동 불변, 기대 객체에 필드만 추가**.
- `detectPipeline.test.ts:120` — 기대 객체에 `vpdEnabled: true`(라이브러리 기본, 3인자 호출). 나머지 필드(vpdCount:1, filteredOut:0 등) **전부 동일** → 거동 불변 확인.
- `detectPipeline.test.ts:427`(§6-15b) — 동일(기본 true 유지).
- `captureRoutes.test.ts:527` — 라우트 경유이므로 `vpdEnabled: false` + `vpdCount:0`. 이건 **라우트 기본 OFF의 정당한 관측**(아래 b와 동류).

### (b) 라우트 기본 false로 VPD 거동이 바뀌어 갱신 — 3건
라우트 기본이 false가 되며 VPD 필터 거동을 검증하던 테스트가 vehicles=0으로 깨진 것. 설계 §8의 "라우트 경유 테스트만 `vpdEnabled:true` 주입" 지침을 그대로 적용해 **원 의도(필터 거동)를 보존**.
- `captureRoutes.test.ts:658`(§6-17) — payload에 `vpdEnabled:true` 주입. 모드A 필터 단언(vehicles 1, filteredOut 1) **동일 유지** → 필터 로직 회귀 0.
- `captureRoutes.test.ts:671`(§6-18) — `vpdOnParkingOnly:false` + `vpdEnabled:true`. 전량 통과 단언 유지.
- `captureRoutes.test.ts:683`(§6-18b) — 강등 사유 단언 유지 + `vpdEnabled:true`.

**판정**: 6건 갱신은 전부 정당. 각 테스트의 **핵심 거동 단언(필터 결과·매칭·강등 사유)은 그대로**이고, 바뀐 것은 (a) 추가 필드 1개 또는 (b) VPD를 켜기 위한 payload 1줄뿐. 회귀를 은닉한 느슨한 수정 없음. 원 의도가 "VPD 필터 거동 검증"인 테스트는 `vpdEnabled:true`로 그 의도를 명시적으로 복원했고, 새로 추가된 §6-19/§6-19b가 "라우트 기본 OFF" 자체를 별도로 봉인한다.

---

## 3. 수동 표면 확인 — 자동 경로 잔존 VPD 0 확정 (검증 항목 3)

리더가 지목한 잔존 `vpd` 호출부 3곳이 **자동 경로(정밀수집 잡 · 라이브 검출 실행 버튼 · 프레임 폴링 자동검출)에서 호출되지 않고 수동 트리거로만 도달**함을 코드로 확정.

| 잔존 호출부 | 트리거 경로 | 자동 경로 여부 | 확정 근거 |
|-------------|-------------|----------------|-----------|
| `SetupOrchestrator.captureSlots` `:83,:95` `vpd.detect` | `POST /setup/run`(`api/server.ts:120,128`) · `/setup/run-from-map`(`:168`) · `tools/e2eSmoke.ts` | **수동/레거시만** | SetupOrchestrator는 원버튼 파이프라인(`SetupPipeline`)이 쓰지 않는다. 자동 체인은 CaptureJob→Finalizer→PtzCalibrator 조립(`SetupPipeline.ts`)이며 orchestrator 미참조. `/setup/run`은 사용자가 직접 치는 별도 레거시 POST 라우트. |
| `mcp/server.ts:83` `vpd.detect`(`vpd_detect` 도구) | MCP 도구 명시 호출(LLM 두뇌가 도구를 부를 때만) | **수동/도구만** | `registerTool('vpd_detect', …)` — 도구 등록일 뿐 자동 루프에서 자발 호출하는 코드 없음. |
| `captureRoutes.ts:482` `vpd.detect`(`GET /capture/vehicle-cuboids`) | 뷰어 진단 쿼리(사용자가 육면체 진단 요청 시) | **수동 진단만** | GET 라우트. 잡·자동 폴링이 이 경로를 부르지 않음(설계 §5 무접촉 명시, 잡은 `/capture/job-cuboids` 인메모리 읽기 사용 — `captureRoutes.ts:529`). |

**자동 경로 3면 전수 확인:**
1. **정밀수집 잡 라운드**(`CaptureJob.captureTarget:380`) — `this.vpdEnabled ? vpd.detect : []`. 라우트가 `vpdEnabled: parsed.data.vpdEnabled ?? false`(`captureRoutes.ts:189`) 전달 → 기본 정지.
2. **라이브 "검출 실행" 버튼**(`POST /capture/detect` → `runDetect:254`) — 라우트가 `vpdEnabled: parsed.data.vpdEnabled ?? false`(`captureRoutes.ts:629`) 전달 → 기본 정지. UI `runLiveDetect(false)`(`app.js:3215`).
3. **프레임 폴링 자동검출**(`app.js:1876` `runLiveDetect()`) — 인자 없음 → 기본값 false → VPD off. 자동 경로 일관.

**확정**: 자동 경로에서 VPD 검출은 **0회**. VPD는 `#cap-vpd-test` 버튼(`app.js:3216` `runLiveDetect(true)`) · `/setup/run` · MCP 도구 · vehicle-cuboids 진단이라는 **수동 표면에서만** 도달 가능.

---

## 4. LPD 보존 확인 (검증 항목 4)

vpd off 라운드에서 (a) `lpd.detect`가 계속 호출되고, (b) `filterPlatesOnPlace`가 vehicles 결박 없이 **폴리곤 직접 필터**로 동작함을 코드+테스트로 확인.

- **lpd.detect 계속 호출**: `CaptureJob.captureTarget:394` — `lpdEnabled && lpd` 게이트는 `vpdEnabled`와 독립. `captureJobVpdOff.test.ts:102`가 vpd off에서 `lpdDetect` **1회** 봉인.
- **폴리곤 직접 필터(vehicles 비결박)**: `onPlaceFilter.ts:72 filterPlatesOnPlace`. `keptVehicles=[]`(vpd off)이면:
  - `matchPlatesToSlots([], plates)` → attached = **빈 집합**(귀속항 (A) 비활성).
  - `keepPlate = (A) OR (B: quadCentroid ∈ 주차면 폴리곤)` → **(B) 폴리곤 직접**만으로 번호판 생존(`:87-91`).
  - 폴리곤 부재 시 → degraded 전량 통과(`:77-78`).
  - ⇒ **vehicles=[]가 번호판을 깎지 않는다**(vehicle 결박 제거 = 마스터가 지목한 "방해 제거"의 본질).
- **테스트 실증**: `captureJobVpdOff.test.ts:105` — vpd off + placeRoiFile 미주입(강등)에서 plate det **1** 누적. `detectPipeline.test.ts:441` — vpd off에서 `out.plates` **1**(폴리곤 미요청 전량).

> **정직 한계(설계 §6 명시 그대로)**: 캡처 라운드에 누적된 plate det는 `Aggregator`가 vehicle 클러스터에서만 slot을 만들어 vpd off 시 **집계에서 폐기**된다. slot_setup.lpd는 캡처 라운드가 아니라 **discovery(LPD-only)** 가 채운다(설계 §1.2). 본 검증 항목 4는 "필터 계층에서 번호판이 vehicle 결박으로 깎이지 않음"을 봉인한 것이며, slot_setup.lpd 영속화 경로와는 별개다(이 리포트가 그 폐기를 통과로 위장하지 않음).

---

## 5. 최종 수치

```
npx tsc --noEmit   → 에러 0
npx vitest run     → Test Files 170 passed (170)
                     Tests      1902 passed (1902)
```
- 구현자 자체 검증 1901 + qa 보강 1(runDetect seg 게이트) = **1902**. 회귀 0.

---

## 6. 한계 / 미관찰 (정직 표기 — 삭제·위장 없음)

- **실 VPD/LPD 미가동 라이브 미관찰**: 외부 VPD/LPD REST와 실 카메라는 미가동이라 유닛(스파이/스텁)만 수행. 설계 §8·구현 §5의 **라이브(리더) 확인 항목은 이 검증에 포함되지 않음**:
  - "검출 실행" → 응답 vehicles 없음(LPD만) · 오버레이 차량 박스 없음 · cap-msg "VPD 미실행".
  - "VPD 검출(테스트)" → vehicles + 플레이트(+육면체) 표시.
  - 정밀수집 시작 → status.vpdEnabled=false 배지 · 라운드 로그에 vpd 호출 없음.
  - → 스파이 수준에서 동일 목적(vpd.detect 0/1 · summary.vpdEnabled)은 결정적으로 봉인됐으나, **실제 화면 오버레이·배지 렌더는 리더의 라이브 확인 필요**.
- **F10 부트스트랩 실 DB 미관찰**: `setupPipeline.test.ts`는 순수 상태머신(finalize 스파이)만 봉인. vpd off + autoChain에서 finalize가 slot_setup 행 + `slot3d_front_center`를 **실제 DB에 기록**하고 하류 discovery→센터링이 부트스트랩되는지는 스텁 경계까지만 검증(실 Finalizer/SqliteStore end-to-end는 리더 라이브 몫). 단, `finalizerFloor`·`checkpointFinalizer` 등 기존 스위트가 finalize 기하 산출 자체는 계속 통과(회귀 0).
- **web/app.js·index.html 유닛 미대상**: 프런트 변경(버튼 바인딩·capStart 고정·배지)은 코드 정독으로 확인(`app.js:2067` capStart `vpdEnabled:false`, `:3215-3216` 버튼 바인딩, `:1804` 배지, `:1876` 폴링 기본 false)했으나 브라우저 실행 미관찰.

---

## 7. 리더(main) 전달

- **소스 결함 없음** — SendMessage 불요. 자동 경로 VPD 0 · LPD 보존 · F10 우회 전부 설계 의도대로 봉인.
- **라이브 확인 요청(§6)**: 실 VPD/LPD·카메라 가동 시 "검출 실행"(vehicles 0) / "VPD 검출(테스트)"(vehicles 표시) / 정밀수집 status.vpdEnabled=false 배지를 눈으로 확인 권장.
- 보강 테스트 1건(`detectPipeline.test.ts` runDetect seg 게이트) 추가 — 문서화(documenter)에 검증 결과 인계.
