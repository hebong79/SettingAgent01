# 02. 구현 변경 요약 — LPD 검지 패널 "DB에 추가" 버튼

설계서 `01_architect_plan.md` 를 그대로 구현. 신규 파일 0(전부 기존 파일 가산), VPD 미접촉.

## 변경 파일

| 파일 | 변경 | 내용 |
|---|---|---|
| `src/setup/plateMatch.ts` | 가산 | `assignPlatesToSlotViews(slots, plates)` export + private `polygonBoundingRect`. import 에 `NormalizedPoint/NormalizedRect`·`SlotSetupView` 추가. `matchPlatesToSlots` 본체 **불변**. |
| `src/api/captureRoutes.ts` | 가산 | `SlotLpdSaveSchema`(zod, 모듈 스코프) + `POST /capture/slots/lpd` 라우트(`/capture/slots/reset` 인접). import 3줄(assign 함수·NormalizedQuad·PlateBox). |
| `web/index.html` | 가산 | `#lpd-run` 뒤에 `#lpd-db-add` 버튼 1개. |
| `web/app.js` | 가산 | `saveLpdToDb()` 함수 + 리스너 1줄(`#lpd-run` 리스너 직후). |

## 핵심 구현 노트

### 1) `assignPlatesToSlotViews` (plateMatch.ts)
- `SlotSetupView` → `BuiltSlot{ positionIdx: slotId, roi: polygonBoundingRect(view.roi), confidence:1 }` 어댑터 후 기존 `matchPlatesToSlots` 위임. 반환 `Map<positionIdx=slotId, quad>` 그대로 반환(slotId 유일 양수 → 키 충돌 없음).
- 스킵 조건: `roi` 없음/길이<3, 또는 좌표 비유한(`Number.isFinite`).
- `polygonBoundingRect`: 정점 min/max → `{x,y,w,h}`. 기존 `quadBoundingRect` 는 quad(4점 튜플) 전용이라 임의 폴리곤용 로컬 유틸 신설(설계서 §3-1).

### 2) `POST /capture/slots/lpd` (captureRoutes.ts)
- body zod: `{cam:+int, preset:+int, plates:[{quad:[{x,y}]×4, confidence?}]}`. 빈 plates 허용(→0건). 파싱 실패 400.
- 처리: `getSlotSetup()` → `camId===cam && presetId===preset && roi.length>=3` 필터 → `plates`→`PlateBox[]`(confidence `?? 0`, `cls:'car_license_plate'`) → `assignPlatesToSlotViews` → rows `{slotId, lpdObb: stringify5(quad), updatedAt: now}` → `deps.store.upsertSlotLpd(rows)`.
- 반환 `{ok:true, updated:N, assigned:[{slotId, confidence}], unassigned: plates.length - map.size}`. assigned.confidence 는 반환 quad **참조 역조회**(plateMatch:59 계약)로 원 plate confidence 부착, 실패 시 slotId 만.
- `store` 만 사용 → 무조건 등록(가드 없음). `stringify5` 기존 import 재사용. `upsertSlotLpd` 부분 UPDATE(wipe 안전). VPD/discovery 자동저장 불변.

### 3) `web/index.html`
- 프로젝트에 `class="secondary"` 는 실존하지 않음(grep 0건). 보조 버튼(align-save-ref 등)은 **클래스 미지정**이 관례 → 설계서 §3-3 대로 클래스 없이 추가. `title` 로 용도 명시.

### 4) `web/app.js` — `saveLpdToDb()`
- `cam/preset` = `state.capFrameKey2?.cam ?? state.cam`(runLiveDetect 동일 프리셋 판별).
- `plates = state.detectByKey[presetKey(cam,preset)]?.plates ?? []`. 비면 `#disc-msg` 안내 후 return.
- `POST /capture/slots/lpd {cam,preset,plates}` → `#disc-msg` 에 `DB 추가: {updated} 슬롯 (미배정 {unassigned})`. 실패 시 `DB 추가 실패: {error}`.
- 저장 후 `loadParkingSlots()`→`drawRoiOverlay()`→`renderSlotList()`(resetSlotSetupDb 선례) 로 `#roi-db` 오버레이 정합 갱신. 오버레이 강제 삭제 없음(retain 정책 준수).

## 정책 준수
- VPD 미접촉(`vpd-auto-detect-forbidden`).
- `stringify5` 소수 5자리 직렬화(`persist-5decimals`).
- 부분 UPDATE `upsertSlotLpd`(`finalize-slotsetup-wipe-fragility`).
- 오버레이 삭제 없이 DB 소스만 재조회(`overlay-retain-policy`).

## 검증
- `npx tsc --noEmit` → **EXIT=0**.
- vitest 는 qa 담당(설계서 §5: `plateMatch.test.ts`·`captureRoutes.test.ts` 확장).

## 한계(설계서 §3-2 기존 명기 — 코드 변경 아님)
- 현재화면 순수 LPD(수동 PTZ) 모드는 좌표계 불일치로 오배정 가능 → 프리셋 정합 검출(순수 LPD/VPD→LPD)에 유효.

---

## v2 개정 — 배정 알고리즘 교체(라이브 한 칸 오배정 수정)

**사유**: 라이브에서 bbox 중심 포함판정이 인접 슬롯 경계부에서 **한 칸 밀림** 오배정 관찰(설계서 §4 v2).

**변경 파일**: `src/setup/plateMatch.ts` 만(시그니처 동일 → 라우트·types·web 무변경).

### `assignPlatesToSlotViews` 본체 교체 (bbox 포함판정 → nearest 하향앵커 전역 1:1 그리디)
- **슬롯 앵커** = `lowerFrontAnchor(s.roi, s.slot3dFrontCenter)` — `src/calibrate/plateDiscoveryWriter.ts` 의 export 재사용(discovery 앞면중심 LOOP와 **동일 앵커·게이트**). setup→calibrate import 1건 신규(비순환 확인). `slot3dFrontCenter==null` 슬롯은 **배정 대상 제외**.
- **plate 중심** = `center(quadBoundingRect(plate.quad))` (기존 유틸 재사용).
- **전역 그리디**: 모든 (plate, slot) 쌍의 `Math.hypot(plate중심 − 앵커)` → 거리 오름차순 정렬 → 양쪽 미배정일 때만 확정(plate·slot 각 ≤1, tie-break=pi·si 결정성). `matchPlatesToSlots` 그리디 골격과 동일 원리(정렬 키만 overlap→거리).
- **거리 상한 게이트** `MATCH_RADIUS = 0.15`(모듈 상수, discovery matchRadiusNorm 동일값): 초과 쌍은 후보 제외 → 초과 plate 미배정(과배정 방지).
- 반환 quad = 입력 `plate.quad` **참조 보존**(라우트 confidence 역조회 계약 유지).

### 고아 정리(CLAUDE.md 자기 고아)
- 초안(v1)의 private `polygonBoundingRect` **제거**(교체로 미사용). 그에 따라 고아가 된 import `NormalizedPoint`·`NormalizedRect` **제거**. `matchPlatesToSlots` 본체·export **불변**.

### 불변 확인
- `matchPlatesToSlots`(VPD 차량-슬롯, finalize/detectPipeline 소비)·`POST /capture/slots/lpd` 라우트·`SlotSetupView` 타입·`web/*`·stringify5·upsertSlotLpd·VPD 정책 모두 무변경.

### 한계·노브(v2)
- `slot3d_front_center` 없는 프리셋(ground 미설정/강등 finalize)은 배정 대상 0 → `updated:0`·전량 미배정. "front_center(지면모델) 필요" 전제.
- `MATCH_RADIUS=0.15` 는 discovery 검증값 — 판 간격이 더 촘촘한 배치가 생기면 재튜닝 노브.

### v2 검증
- `npx tsc --noEmit`(SettingAgent) → **EXIT=0**.
- vitest 는 qa 담당(설계서 §5 v2: 라이브 재현 slot10~13 밀림 제거·null 스킵·게이트 양면).
