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

센터라이징 잡 **done 경로**의 최종 저장 지점에 산출물 1종을 가산했다.

```ts
const slots = this.store.getSlotSetup();       // 1회 조회 → 아카이브·최종결과물 공용(동일 시점 뷰 보장)
try { this.saveStore.saveSnapshot(setupSaveName(new Date()), { createdAt, slots, centering: items }); } catch { warn }
try { this.saveStore.saveSnapshot(SETUP_RESULT_NAME, buildSetupResult(slots)); } catch { warn }   // ★ 신규
```

- 두 저장은 **각자 best-effort**(try 분리) — 아카이브 실패가 최종결과물 기록을 막지 않는다.
- 기존 불변식 유지: `error` 경로는 미기록(부분·불신), `saveStore` 미주입 시 no-op, 기록 실패는 격리되어 잡은 `done`.
- 저장 순서: DB UPDATE(`saveCenteringSlots`) → `getSlotSetup()` 재조회 → 기록. 즉 **PTZ 가 반영된 최신 뷰**가 담긴다.

저장 산출물은 이제 4종: `data/slot_ptz.json`(정본) · DB `slot_setup` · `save/Setup_*.json`(아카이브) · **`save/setup_result.json`(최종결과물)**.

## 3. 검증

- 신규 `test/setupResult.test.ts` 7건 — 샘플 파일과 키 집합 교차 비교, `centering`/`occupy_roi` null 규칙, 부분 PTZ 방출 금지, 순서 보존, 빈 입력, 파일명 안전화 통과.
- `test/centeringPreAim.test.ts` B-1.5 갱신 — done 시 `saveSnapshot` **2회**(아카이브 + `setup_result`), 아카이브 실패해도 `setup_result` 기록됨을 추가 검증.
- 회귀: `ptzCalibrator{,.point,AimPoint,Ladder}` · `saveStore` · `setupPipeline` 포함 **101 tests 통과**, `tsc --noEmit` 클린.
- 실 파일 기록 확인(E2E): `SaveStore` 로 실제 기록 → `save/setup_result.json` 이 샘플과 동일한 구조로 생성되고, `stringify5` 규약대로 소수점 5자리로 반올림됨(`0.0298512345` → `0.02985`)을 확인.

## 4. 영향도 분석

| 대상 | 영향 |
|---|---|
| `PtzCalibrator` | 저장 단계에 쓰기 1건 가산. 상태머신·제어루프·기존 산출물 로직 불변 |
| `SaveStore` | **무변경**(기존 `saveSnapshot` 재사용) |
| DB / `slot_ptz.json` | **무변경** — 소스로만 읽음 |
| REST 라우트 / 뷰어 | **무변경**. `GET /capture/saves` 목록에 `setup_result` 항목이 추가로 노출됨(이름 고정이라 매 실행 덮어쓰기, 목록 증가 없음) |
| `reports/` 미러 | `SaveStore` 에 `reportsDir` 가 주입돼 있으면 `reports/setup_result.json` 에도 동일 JSON 이 미러됨(기존 규약) |
| 수동 저장(`POST /capture/save`) | **무변경** — 이번 변경은 센터라이징 done 경로 자동 저장에만 적용 |

주의: `save/setup_result.json` 은 고정 이름이라 **센터라이징 잡이 done 될 때마다 덮어쓰인다.** 이력이 필요하면 기존 `Setup_YYYYMMDD_HHMMSS.json` 아카이브를 사용한다.
