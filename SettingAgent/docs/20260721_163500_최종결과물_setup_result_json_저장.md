# 최종 결과물 `save/setup_result.json` 저장

- 날짜: 2026-07-21
- 브랜치: `feat/setup-result-json`
- 요구: `data/setup_result_sample.json` 스키마대로 최종 결과물 `setup_result.json` 을 `save/` 폴더에 생성

## 1. 설계

### 스키마(샘플 정본)

```jsonc
{ "slots": [ {
  "slotId": 1, "camId": 1, "presetId": 1, "presetSlotIdx": 1,
  "floor_roi":  [{ "x": 0.02985, "y": 0.76733 }, ...],   // 주차면 바닥 폴리곤(정규화)
  "occupy_roi": [{ "x": 0.0957,  "y": 0.71254 }, ...],   // 점유영역(발자국) 폴리곤
  "centering":  { "pan": 7.68045, "tilt": 10.74063, "zoom": 8.99252 }
} ] }
```

### 소스 매핑 — `slot_setup`(DB 정본) → `setup_result.json`

| 결과 키 | 소스(`SlotSetupView`) | 비고 |
|---|---|---|
| `slotId` / `camId` / `presetId` / `presetSlotIdx` | 동명 필드 | 그대로 |
| `floor_roi` | `roi` (`slot_roi`) | 정규화 4점 |
| `occupy_roi` | `occupyRange` (`occupy_range`) | 미도출 슬롯은 `null` |
| `centering` | `pan`/`tilt`/`zoom` | 셋이 **모두** 있을 때만 객체, 아니면 `null` |

**정직성 규약:** 미센터라이징·점유 미도출 슬롯을 `0` 이나 빈 배열로 위장하지 않고 `null` 로 방출한다.
부분 PTZ(예: zoom 만 null)도 `centering: null` — 반쪽 값을 결과물에 흘리지 않는다.

행 순서는 소스인 `getSlotSetup()`(`ORDER BY cam_id, preset_id, preset_slotidx`)을 그대로 보존한다.

## 2. 변경 내용

### 신규 `src/store/setupResult.ts`

- `SETUP_RESULT_NAME = 'setup_result'` — 고정 파일명(확장자 제외, `SaveStore.saveSnapshot` 규약).
  타임스탬프 아카이브와 달리 **항상 같은 이름으로 덮어써** 소비측이 고정 경로 `save/setup_result.json` 을 읽는다.
- `buildSetupResult(slots: SlotSetupView[]): SetupResult` — 순수 변환 함수(IO 없음).
- 타입 `SetupResult` / `SetupResultSlot`.

### 수정 `src/calibrate/PtzCalibrator.ts` — `saveSetupSnapshot()`

센터라이징 잡 **done 경로**에서 최종결과물을 **동일 내용 2벌**로 기록한다.

```ts
const result = buildSetupResult(this.store.getSlotSetup());   // 1회 변환 → 2벌 동일 내용 보장
try { this.saveStore.saveSnapshot(setupSaveName(new Date()), result); } catch { warn }  // 이력본 Setup_YYYYMMDD_HHMMSS.json
try { this.saveStore.saveSnapshot(SETUP_RESULT_NAME, result); } catch { warn }          // 고정본 setup_result.json
```

| 파일 | 성격 |
|---|---|
| `save/Setup_YYYYMMDD_HHMMSS.json` | **이력본** — 실행마다 새 파일, 덮어쓰기 없음 |
| `save/setup_result.json` | **고정본** — 소비측이 읽는 고정 경로, 매 실행 덮어쓰기 |

- 두 기록은 **각자 best-effort**(try 분리) — 한쪽 실패가 다른쪽을 막지 않는다.
- 동일 `result` 객체를 두 번 쓰므로 두 벌의 내용이 갈릴 수 없다(테스트에서 참조 동일성으로 고정).
- 기존 불변식 유지: `error` 경로는 미기록(부분·불신), `saveStore` 미주입 시 no-op, 기록 실패는 격리되어 잡은 `done`.
- 저장 순서: DB UPDATE(`saveCenteringSlots`) → `getSlotSetup()` 재조회 → 기록. 즉 **PTZ 가 반영된 최신 뷰**가 담긴다.

**★ 이전 동작에서 바뀐 점:** `Setup_*.json` 의 내용이 기존 `{createdAt, slots(원시 slot_setup 뷰), centering(센터링 상세 items)}` 에서
최종결과물 스키마(`{slots:[...]}`)로 **교체**되었다. 이력본을 그대로 갖다 쓸 수 있게 하기 위함이며,
센터링 상세(`converged`/`reason`/`iterations`)는 정본 `data/slot_ptz.json` 에 그대로 남는다.

저장 산출물은 4종: `data/slot_ptz.json`(센터링 정본) · DB `slot_setup` · `save/Setup_*.json`(이력본) · `save/setup_result.json`(고정본).

## 3. 검증

- 신규 `test/setupResult.test.ts` 7건 — 샘플 파일과 키 집합 교차 비교, `centering`/`occupy_roi` null 규칙, 부분 PTZ 방출 금지, 순서 보존, 빈 입력, 파일명 안전화 통과.
- `test/centeringPreAim.test.ts` B-1.5 갱신 — done 시 `saveSnapshot` **2회**(`Setup_*` 이력본 + `setup_result` 고정본), 두 payload 참조 동일(내용 분기 불가), 슬롯 키 순서, 이력본 실패해도 고정본 기록됨.
- 회귀: `ptzCalibrator{,.point,AimPoint,Ladder}` · `saveStore` · `setupPipeline` 포함 **123 tests 통과**, `tsc --noEmit` 클린.
- 실 파일 기록 확인(E2E): `SaveStore` 로 실제 기록 → `Setup_20260721_170245.json` 과 `setup_result.json` 두 파일 생성, **바이트 단위 동일**, 샘플과 같은 구조, `stringify5` 규약대로 소수점 5자리 반올림(`0.0298512345` → `0.02985`).

## 4. 영향도 분석

| 대상 | 영향 |
|---|---|
| `PtzCalibrator` | 저장 단계에 쓰기 1건 가산 + 기존 `Setup_*.json` **payload 스키마 교체**. 상태머신·제어루프·`slot_ptz.json`/DB 로직 불변 |
| `SaveStore` | **무변경**(기존 `saveSnapshot` 재사용) |
| DB / `slot_ptz.json` | **무변경** — 소스로만 읽음 |
| REST 라우트 / 뷰어 | **무변경**. `GET /capture/saves` 목록에 `setup_result` 항목이 추가로 노출됨(이름 고정이라 매 실행 덮어쓰기, 목록 증가 없음) |
| `reports/` 미러 | `SaveStore` 에 `reportsDir` 가 주입돼 있으면 `reports/setup_result.json` 에도 동일 JSON 이 미러됨(기존 규약) |
| 수동 저장(`POST /capture/save`) | **무변경** — 이번 변경은 센터라이징 done 경로 자동 저장에만 적용 |

주의:
- `save/setup_result.json` 은 고정 이름이라 **센터라이징 잡이 done 될 때마다 덮어쓰인다.** 이력은 같은 내용의 `Setup_YYYYMMDD_HHMMSS.json` 에 실행마다 쌓인다.
- `Setup_*.json` 을 기존 payload(`createdAt`/`centering` 키)로 파싱하던 외부 소비자가 있다면 스키마 교체의 영향을 받는다. 코드베이스 내에는 해당 소비자가 없다(뷰어 "열기"는 `SetupArtifact` 형만 다루며 `Setup_*.json` 은 이전에도 그 형이 아니었다).
