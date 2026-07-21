# 검증 보고: 센터라이징 개명 + PtzCalibrator→PlatePtz 위임 + slot_ptz.json/DB(centering_slot) 이중 저장

작성: 2026-07-16 / 검증자(qa-tester)
브랜치: `feat/vpd-seg-cuboid`
대상: 설계서 `_workspace/centering/01_architect_plan.md` §9 (T1~T13) / 구현자 보고 `02_developer_changes.md`

> ## 3줄 요약
> 1. **T1~T13 전량 구현·통과 + 가산 3건(T14·warn·경계면). 전량 1731 passed / 0 failed, typecheck 무오류. 회귀 0 을 독립 재현 확인.**
> 2. **뮤테이션 반증 10건 전부 탐지(10/10)** — 구현을 일부러 망가뜨리면 테스트가 실제로 빨개진다. 단, **최초 작성한 T6 는 무의미했고 뮤테이션으로 적발해 수정**했다(§4).
> 3. **라이브 왕복 성공** — 리더의 setup_artifact 복원이 반영되어 `total:1` 실행 → JSON·DB 동시 기록 확인, **2회 실행 멱등(행수 1 불변) 라이브 실증**. 단 설계서 §10 Goal 4(독립 재관측 errX/errY)는 **미수행 — 한계로 명시**(§6).

---

## 1. 기준선 — 구현자 주장 검증 결과: **실질 정확, 표현은 부정확**

리더 지시문의 "1667" 은 **재현되지 않았다**(구현자 보고와 일치). 다만 구현자의 "HEAD = 1713 passed" 도 문자 그대로는 부정확하다. `git stash` 가 아닌 **격리 worktree(HEAD detached)** 로 독립 측정했다:

| 측정 | 명령 | 결과 |
|---|---|---|
| HEAD(클린 체크아웃, worktree) | `npx vitest run` | **1709 passed + 4 skipped (총 1713)** |
| 4 skipped 의 정체 | — | `test/placeRoiRuntimeInvariants.test.ts` — `data/Place01/PtzCamRoi.json`(**untracked**) 부재 시 `describe.skipIf` 로 스킵 |
| 같은 파일을 메인 트리에서 단독 실행 | `npx vitest run test/placeRoiRuntimeInvariants.test.ts` | **4 passed** |
| HEAD 를 메인 트리 환경으로 정규화 | 1709 + 4 | **1713 passed** ← 구현자 주장과 일치 |
| 현재(변경 후) | `npx vitest run` | **1710 passed / 0 failed** |
| 차분 | | **−3** |

**−3 의 정체를 독립 확인**: `git diff HEAD -- test/ptzCalibrator.test.ts` 결과 삭제된 `it` 은 정확히 3개(`describe('PtzCalibrator LLM off/실패 폴백')` 의 3케이스)뿐이며, 그 외 어떤 테스트도 삭제·비활성화되지 않았다. → **회귀 0 확정(구현자 주장 재현 성공).**

> **⚠ 후속 검증자에게(중요)**: 신규 클론·CI 처럼 `data/Place01/` 이 없는 환경에서는 숫자가 **4씩 낮게** 나온다(HEAD 1709 / 변경후 1706). 차분 −3 은 동일하게 성립하나, **절대값 1713/1710 을 게이트로 박으면 CI 에서 오탐**한다. 기준선은 절대값이 아니라 **차분**으로 관리할 것.

**신규 테스트 추가 후 최종**: **155 files / 1731 passed / 0 failed**, `npm run typecheck` 무오류.
(1710 + 신규 21 = 1731 — `centeringSlot.test.ts` 20 + `centeringBoundary.test.ts` 1)

---

## 2. 설계서 §9 T1~T13 케이스별 결과

신규 파일 2개: `test/centeringSlot.test.ts`(T1~T14), `test/centeringBoundary.test.ts`(경계면 교차 비교).

| # | 케이스 | 결과 | 비고 |
|---|---|---|---|
| T1 | gain 체이닝 실증 | ✅ | `opts[1].gain` **=== `c.gain`(동일 참조, `toBe`)**, `zoomToPlateWidth` startPtz **=== `c.ptz`**, `opts[1].plateRoi` = center 결과 boundingRect |
| T2 | 위임 후 수렴 회귀 | ✅ | centered/converged true, plateWidth≈0.2, globalIdx=7, reason 없음 |
| T3 | 시작 PTZ 정본 | ✅ | `listCameras`(22/6.8/1.69341) 부여 → `moves[0]` 이 정확히 프리셋 PTZ |
| T4 | 시작 PTZ 폴백 | ✅ | 0/0/1 시작 + 잡 done. **가산: warn 실발화 단언**(조용한 강등 아님 — 리더 지시 6) |
| T5 | reason 매핑 4종 | ✅ | `no_plate`/`plate_lost`/`zoom_saturated`/`max_iterations` 전부 **실 PlatePtz 구동**으로 확인(스텁 아님) |
| T6 | center 실패 시 zoom 미시도 | ✅ | `zoomToPlateWidth` 0회 + **zoom 인스턴스 생성 자체가 0회**. ※ **최초 작성본은 무의미했음 — §4 참조** |
| T7 | DB 멱등(2회 실행) | ✅ | 행수 2 → 2(중복 0), `pos` JSON parse === `item.ptz` |
| T8 | DB 미주입 정상 | ✅ | store 생략 → done + JSON 저장, 예외 없음 |
| T9 | preset_slotidx 도출 | ✅ | coveredSlotIds `['a','b','c']` 의 `'b'` → **2(1-based)**, 미포함 → null, presets 부재 → null |
| T10 | 부분 캘리브레이션 delete 범위 | ✅ | 2행 → 슬롯1만 재실행 → **여전히 2행**, 타 행 `updated_at` 불변(`T-first` 유지) |
| T11 | 실패 슬롯 DB 미저장 + last-known-good | ✅ | 2회차 no_plate 시 JSON 엔 reason, DB 는 1회차 `pos`·`updated_at` **완전 불변** |
| T12 | upsertCenteringSlots 단위 | ✅ | insert/동일PK 갱신/AS 매핑/**NULL presetSlotIdx 왕복**/같은 slot_id 라도 preset 다르면 별도 행(PK 3키) |
| T13 | DB 예외 격리 | ✅ | `upsertCenteringSlots` throw → **state='done' 유지** + JSON 정상 |
| **T14** | **(가산) items↔targets zip 정렬** | ✅ | §5 참조 — 설계서 미명세 위험 지점 |

---

## 3. 뮤테이션 반증 — "이 테스트가 실제로 빨개지는가" (10/10 탐지)

녹색 테스트는 그 자체로 아무것도 증명하지 않는다. 구현을 **일부러 망가뜨려** 각 테스트가 실제로 실패하는지 확인했다(각 회차 후 소스 원복, `git diff --stat` 로 무오염 확인).

| # | 뮤테이션(구현 훼손) | 대상 | 결과 |
|---|---|---|---|
| M1 | `gain: c.gain` **삭제**(체이닝 절단) | T1 | 🔴 **RED — 탐지** |
| M2 | zoom prior 를 `t.plateRoi`(센터링 前)로 회귀 | T1 | 🔴 **RED — 탐지** |
| M3 | 가드 `!c.ok \|\| !c.plate` → `!c.plate`(미중심 zoom 허용) | T6 | 🟢 **GREEN — 탐지 실패 → 테스트 결함 발견(§4)** → 수정 후 🔴 **RED** |
| M4 | upsert → **전량 `DELETE FROM centering_slot`** + insert | T10 | 🔴 **RED — 탐지** |
| M5 | DB best-effort `try/catch` 제거 | T13 | 🔴 **RED — 탐지** |
| M6 | 실패 슬롯 필터(`!centered \|\| !converged`) 제거 | T11 | 🔴 **RED — 탐지** |
| M7 | `presetSlotIdx: pos + 1` → `pos`(0-based 회귀) | T9 | 🔴 **RED — 탐지** |
| M8 | `resolvePresetPtz` 결과 무시(항상 0/0/1) | T3 | 🔴 **RED — 탐지** |
| M9 | 폴백 `logger.warn` 삭제(조용한 강등) | T4 | 🔴 **RED — 탐지** |
| M10 | zip 을 `targets[i]` → `targets[0]` 으로 오염 | T14 | 🔴 **RED — 탐지** |

**결론: 리더 지시 1·2·3 의 반증 시도 결과 — 구현자 주장은 전부 참이며, 그것을 검증하는 테스트도 유효하다.**
- 지시 1(gain 체이닝): M1 로 체이닝을 끊으면 T1 이 실제로 빨개진다 → **T1 은 무의미하지 않다.**
- 지시 2(§7 함정): M2 로 prior 를 센터링 前 값으로 되돌리면 T1 이 빨개진다 → 구현은 실제로 center 결과 boundingRect(0.47/0.48)를 쓴다.
- 지시 3(전량 delete 회귀): M4 로 회귀시키면 T10 이 빨개진다 → upsert 멱등·부분보존은 실재한다.

---

## 4. ★ 발견한 문제 1: 내가 최초 작성한 T6 은 **무의미한 테스트였다**(뮤테이션으로 적발·수정 완료)

**이 항목은 구현 결함이 아니라 검증 결함이다.** 정직하게 기록한다.

- **증상**: M3(가드에서 `!c.ok` 를 제거해 **미중심 상태에서도 zoom 을 시도**하도록 훼손)를 적용해도 T6 이 **통과**했다.
- **원인**: 최초 T6 의 fixture 가 `plate: null` 이었다. 그러면 가드의 `!c.plate` 절만으로 걸러져, **설계서 §3 의 의미 변화 본체인 `!c.ok` 절이 한 번도 실행되지 않았다.** 게다가 그 fixture 는 **비현실적**이다 — 실제 `PlatePtz` 의 `max_iterations`/`plate_lost` 반환은 마지막 관측 `plate` 를 **non-null 로 싣는다**(`platePtz.ts:228`·`:250`).
- **수정**: fixture 를 `plate: CENTERED_PLATE`(non-null, reason `max_iterations`)로 교체 → M3 를 **정상 탐지(RED)**. `plate:null`(no_plate) 경로는 별도 케이스로 분리 보존.
- **교훈**: 위임 스텁의 반환값은 **피위임 모듈의 실제 반환 계약과 일치**해야 한다. 아니면 테스트가 실제로는 존재하지 않는 분기를 검증하게 된다.

---

## 5. 발견한 문제 2: 설계서 미명세 위험 — items↔targets zip 정렬 (검증 결과 **구현은 정상**)

`saveCenteringSlots` 는 `items[i]` 의 `presetSlotIdx` 를 **`targets[i]` 에서 index 로 zip** 해 가져온다(PtzCalibrator.ts:211). 설계서 §5-6 은 "items 는 targets 와 인덱스 1:1"이라고 **전제**하지만 이를 검증하는 케이스는 T1~T13 에 없다. 정렬이 깨지면 **DB 에 조용히 틀린 `preset_slotidx` 가 쓰인다**(예외 없음·로그 없음 — 발견이 매우 어려운 종류의 결함).

- **T14(가산)**: 2슬롯 중 **앞 슬롯이 전송계층 예외로 실패**하는 시나리오 → 뒤 슬롯의 `presetSlotIdx` 가 밀리는지 확인.
- **결과: 구현 정상** ✅ — `run()` 의 catch 가 타깃당 정확히 1개의 `skipItem` 을 push 하므로 예외 경로에서도 1:1 이 보존된다. M10(zip 오염)으로 T14 의 유효성도 확인.

---

## 6. 경계면 교차 비교 (ParkAgent 하네스 필수) — `test/centeringBoundary.test.ts`

**모킹이 아닌 실 파일 DB + 실 `writeSlotPtz` + 실 fastify 라우트**로 왕복시켜 검증했다.

| 경계 | 검증 | 결과 |
|---|---|---|
| REST `/calibrate/result` ↔ `slot_ptz.json` | 응답 키 = `['createdAt','items']`(SlotPtzArtifact 계약), 성공 item 키 = `['camIdx','centered','converged','globalIdx','plateWidth','presetIdx','ptz','slotId']` — **성공 시 `reason` 키 자체가 없음** | ✅ |
| `centering_slot` 컬럼 | `['cam_id','pos','preset_id','preset_slotidx','slot_id','updated_at']` — 마스터 지정 스키마 + 관례 `updated_at` | ✅ |
| DB `pos` ↔ JSON `item.ptz` | `JSON.parse(row.pos)` **=== `item.ptz`**(완전 일치), 키 `['pan','tilt','zoom']` | ✅ |
| **1-based 규약**(전체아키텍처 §211) | `camIdx`/`presetIdx`/`cam_id`/`preset_id` = 1, **`preset_slotidx` = 1·2**(coveredSlotIds 순서, 0 아님) | ✅ |
| 성공 항목 수 == DB 행 수 | 실패 슬롯 DB 미저장(설계서 §5-5-5) | ✅ |
| `pos.zoom` 범위 | ∈ [1, 36] | ✅ |

**구현자 보너스 발견 검증(리더 지시)**: `GET /db/table/centering_slot` 이 라우트 변경 없이 동작하는지 — **실제로 호출해 확인 완료**. 유닛(fastify.inject)에서 200 + 정확한 컬럼, **그리고 아래 §7 에서 실기동 서버(:13020)로도 200 확인**. `dbRoutes.ts:53-57` 의 `sqlite_master` 동적 화이트리스트라 신테이블이 자동 노출된다 — **구현자 주장 참**.

---

## 7. 라이브 검증 — **가능해졌고, 수행함** (지시문 전제 변경됨)

**지시문 전제("`setup_artifact.json` 이 `slots:[]` 라 라이브가 막혀 있다")는 검증 시점에 이미 해소되어 있었다.** 리더의 복원이 반영되어 `presets:1 / slots:1 / globalIndex:1`(슬롯 `c1p2s1`, `plateRoiByPreset:['1:2']`)로 채워져 있었고, SettingAgent 가 **:13020 에서 실기동 중**(`{"status":"ok","camera":true,"vpd":false,"brain":true}`)이었다.

### 7-1. 기존 라이브 실행 실물(1회차 — 리더 실행 추정, 14:52)

```
GET /calibrate/status → {"state":"done","done":1,"total":1,...}   ← total 0 아님(복원 실증)
data/slot_ptz.json    → items 1건: centered=true, converged=true, plateWidth=0.18977, zoom=14.288
DB centering_slot     → 1행: cam_id=1, preset_id=2, preset_slotidx=1,
                        pos={"pan":51.536833065211916,"tilt":9.365407018432439,"zoom":14.287834731748562}
```
- **`pos` 가 `item.ptz` 와 바이트 단위 일치**(부동소수 전자리) — 라이브 경계면 정합 확인.
- `updated_at`(…58.**620**Z) vs JSON `createdAt`(…58.**619**Z) 1ms 차 — `writer` → `saveCenteringSlots` 순서 실증.
- **`centering_slot` 이 기존 실파일 DB(`data/observations.sqlite`)에 정상 생성됨** — `CREATE TABLE IF NOT EXISTS` 가산이 구DB 마이그레이션에서 동작함을 실물 확인(설계서 §5-5).

### 7-2. 내가 직접 수행한 2회차(멱등 라이브 — 설계서 §10 Goal 5)

`POST /calibrate/ptz {}` → `{"ok":true,"started":true,"total":1}` → done(14:56:32).

| 항목 | 1회차(14:52) | 2회차(14:56) | 판정 |
|---|---|---|---|
| DB 행수 | 1 | **1 (불변)** | ✅ **멱등 라이브 실증** — 중복 행 0, 기존 행 in-place 갱신 |
| `pan` | 51.536833 | 51.539713 | Δ0.0029° |
| `zoom` | 14.2878 | 14.4025 | Δ0.11 |
| `plateWidth` | 0.18977 | 0.18936 | 둘 다 **∈[0.18,0.22]**(설계서 Goal 4 폭 기준 충족) |
| centered/converged | true/true | true/true | ✅ |

**해석**: 서로 다른 시점의 독립 2회 실행이 **pan 0.003° 이내로 재수렴**했다. 폐루프가 우연이 아니라 실제로 동작하며 재현성이 높다는 강한 증거다.

### 7-3. 설계서 §10 Goal 대조

| Goal | 결과 |
|---|---|
| 1. UI "센터라이징" 문구 + 진행률·완료 | ⚠️ **정적 확인만** — `index.html:208 <h3>센터라이징</h3>`, `:213 버튼 "센터라이징"`, `:209` 설명에 `centering_slot` 명기, `id="cal-start"`·`calStart()` 불변, `app.js:2021` total===0 안내 분기 존재. **브라우저 실화면 클릭은 미수행**(§8) |
| 2. `slot_ptz.json` items≥1, 성공항목 centered&&converged | ✅ **라이브 확인** |
| 3. `GET /db/table/centering_slot` — 성공수==행수, zoom∈[1,36], preset_slotidx 1-based | ✅ **실기동 서버로 확인** |
| 4. 성공항목 독립 재관측(errX/errY ≤ 0.03, 폭∈[0.18,0.22]) | ⚠️ **부분** — 폭 0.1894 ∈[0.18,0.22] 충족. **errX/errY 독립 재관측(전체목록 공통변위 기법)은 미수행 → §8 한계** |
| 5. 2회 실행 → DB 행수 불변 | ✅ **라이브 실증**(§7-2) |

---

## 8. 커버하지 못한 범위 (한계 — 통과로 위장하지 않음)

1. **[미수행] 설계서 §10 Goal 4 의 독립 재관측** — 결과 PTZ 로 재캡처→LPD 후 `errX`,`errY` ≤0.03 을 **외부에서 독립 측정**하는 절차는 수행하지 않았다. 현재 `centered=true` 는 **폐루프 자신의 마지막 관측 기준** 판정이라 자기보고다(폭은 독립 지표가 일치하나, 중심오차는 아니다). 2회 독립 실행의 재수렴(§7-2)이 정황 증거이나 **Goal 4 의 대체물은 아니다.** → goal/loop 담당이 수행 필요.
2. **[미수행] 브라우저 실화면 UI 검증** — 문구·분기는 소스 정적 확인만 했다. 실제 클릭→진행률→요약 렌더(`renderCalResult`)는 미확인.
3. **[미수행] `vpd:false` 영역** — 실기동 서버의 VPD 가 down 이나 센터라이징 경로는 camera+LPD 만 쓰므로 이번 검증에 영향 없음.
4. **[미수행] 다중 카메라·실카메라 일반화** — fallback 게인 −62/−35.5 는 cam1 시뮬 실측 유래(설계서 R2). 라이브 검증은 cam1/preset2 **단일 슬롯 1건**뿐이다. 다슬롯·다프리셋 라이브 배치는 미검증(유닛에선 2슬롯 커버).
5. **[미수행] 부분 캘리브레이션 라이브** — T10 으로 유닛 커버했으나, 라이브 `start(slotIds)` 왕복은 슬롯이 1개뿐이라 의미 있는 실행 불가.
6. **[구조적 한계] `data/Place01` 의존** — §1 의 4-skip 이슈. 신규 클론 환경에서는 절대 테스트 수가 달라진다.

---

## 9. 부수 발견 (이번 변경 범위 밖 — 손대지 않음, 보고만)

1. **[기존 결함] `dbRoutes.ts` 의 DB 커넥션 누수** — `getDb()` 가 지연 오픈한 read-only 커넥션을 **닫는 경로가 없다**(`onClose` 훅 부재). `app.close()` 후에도 핸들이 남아 Windows 에서 임시 DB 파일 삭제가 `EPERM` 으로 실패한다(내 경계면 테스트에서 실측 → 정리를 best-effort 로 우회). **`dbRoutes.ts` 는 이번 브랜치에서 0줄 변경**이므로 CLAUDE.md §3 에 따라 언급만 한다. 실서버는 프로세스 수명과 동일해 실해는 낮으나, **테스트·툴링에서 임시 DB 정리를 방해**한다 → 후속과제 후보.
2. 구현자 보고 §5 의 4·5번(문서 stale, R4 잔존)은 검증 범위 밖이나 사실로 확인됨.

---

## 10. `platePtz.ts`/`controlMath.ts` 0줄 변경 — 독립 확인 ✅

```
$ git diff --stat HEAD -- src/calibrate/platePtz.ts src/calibrate/controlMath.ts src/api/calibrateRoutes.ts
(출력 없음 — 0줄 변경)
```
전체 변경은 13파일(소스 7 + 테스트 3 + web 2 + config 1)로 구현자 보고 §1 표와 일치. brain 계층도 무접촉이며 관련 테스트 전부 green 유지.

---

## 11. 구현자에게 — **재현 필요한 실패: 없음**

**이번 검증에서 구현 결함은 발견되지 않았다.** 설계서 §5-2 의사코드·§5-4 매핑표·§5-5 DDL·§6 config 정정이 전부 실물과 일치하며, 10건의 뮤테이션 반증으로 각 계약이 **실제로 강제되고 있음**을 확인했다.

수정 요청 대신 참고 사항 2건:
1. **테스트 기준선 표현**: "HEAD 1713 passed" → 정확히는 "**총 1713(클린 체크아웃 기준 1709 passed + 4 skipped)**". 차분 −3 결론은 정확하다. CI 게이트를 절대값으로 걸지 말 것(§1 경고).
2. **§5-6 의 "items↔targets 인덱스 1:1" 전제**는 이제 T14 로 회귀 고정됐다(구현은 정상). 향후 `run()` 의 예외 흡수 경로를 수정할 때 이 불변식을 깨면 **DB 에 조용히 틀린 `preset_slotidx` 가 쓰인다** — T14 가 방어한다.

## 12. 문서화(documenter)에게 — 검증 결과 전달

- **완료 게이트 충족**: `npm test` **155 files / 1731 passed / 0 failed** + `npm run typecheck` 무오류. 회귀 0(−3 = 설계서 §9 의도된 LLM 자문 삭제, 독립 확인).
- **신규 테스트 자산 2파일**: `test/centeringSlot.test.ts`(T1~T14, 20케이스), `test/centeringBoundary.test.ts`(경계면 교차 비교 1케이스).
- **라이브 실증 수치**(문서에 인용 가능): 2회 독립 실행 `plateWidth` 0.18977/0.18936, `zoom` 14.29/14.40, **DB 행수 1 불변(멱등)**, `preset_slotidx=1`(1-based).
- **문서에 반드시 반영할 한계**: §8 의 6개 미커버 항목 — 특히 **Goal 4(독립 재관측) 미수행**과 **라이브가 cam1/preset2 단일 슬롯 1건뿐**임.
- **후속과제 후보 1건 추가**: §9-1 `dbRoutes` 커넥션 누수(기존 결함, 범위 밖).
