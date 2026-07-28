# 00 리더 컨텍스트 — L3 후속: 미리보기 UX 수정 + `PtzCamRoi_auto.json` 분리 + slot_setup 재구성

작성: 2026-07-28 / 실행 모드: **B(goal/loop)** — `Goal:`/`Loop:`/`Requirements:` 구조.
선행 라운드 산출물: `SettingAgent/_workspace_prev_20260728_L3/00~04`, 문서 `docs/20260727_235515_L3_*.md`

## Goal
① 지면격자 패널 **미리보기 무반응 UX 결함** 수정
② 자동 결과를 기존 수동 floor ROI 와 **파일 분리**(`PtzCamRoi_auto.json`)
③ 승인 버튼 → **slot_setup 전량 재구성 저장**

## 리더 실측 (재조사 불필요)

### 미리보기 무반응 — 서버는 정상이다
라이브 라우트 직접 확인(13020):
```
POST /capture/ground-grid/bootstrap  (정규화 quad)
→ ok:true · preset1 matched 7/7 · avgIoU 0.9999768 · applicable:true
   d=4.95001m · fovBaseV=34.63498° · θ=89.99990° · 7열×1행 · onLattice 7/7 · medianResid 0.0000242m
```
정적자산도 최신: 서버가 `Cache-Control: no-store` 로 새 `app.js`(ggPreview 포함) 서빙,
`gg-*` id **9개 HTML↔JS 전부 일치**, 리스너 배선됨(`app.js:4515`), 라우트 등록됨(404 아님).

**→ 원인은 클라이언트 UX 하나**: `ggPreview()`(`app.js:1961~1966`)가 기준 주차면 미선택 시 **즉시 return**,
안내는 `#gg-msg` 의 작은 텍스트뿐. 캔버스·표가 안 변해 **눈에는 완전한 무반응**.
`gg-apply` 에는 disabled 게이트가 있는데 **`gg-preview` 에는 없다**(`app.js:1919-1920` 대조).

부수 확인: `parking_spaces.idx` 는 **전역 1..23**(cam1 p1:1-7 / p2:8-11 / p3:12-13 / cam2 p1:14-19 / p2:20-23)
이고 `selectedPlaceIdx = row.globalIdx` 와 규약이 일치한다 — **인덱스 불일치 버그는 없다**.
`loadPlaceRoi()` 는 precise 탭 진입 시 자동 호출된다(`app.js:4121`) — 별도 로딩 선행조건은 없다.

## 리더 결정 (변경 금지)

### D-1' 파일 2개 분리 — 직전 라운드 D-1 을 **대체**
자동 결과는 **`PtzCamRoi_auto.json`** 에 쓰고 수동 정본 `PtzCamRoi.json` 은 자동 경로가 **건드리지 않는다**.
근거: 출처 추적(사람이 그린 것 vs 기계 파생물) · 되돌리기(`_auto` 삭제로 원상복구) · 기존 수동 경로 회귀 0 ·
마스터 요구("기존 floor_ROI 와 구분하여 관리").

### D-2' 소스 선택 스위치 (필수 후속)
`Finalizer.persistSlotSetupFromPlace` 는 `PtzCamRoi.json` 만 읽고 매 finalize 마다 `replaceSlotSetup`(전량 교체)
를 호출한다. → `_auto.json` 에만 쓰면 자동 결과가 slot_setup 에 도달하지 못할 뿐 아니라
**다음 finalize 에서 전량교체로 소멸한다.**
**명시적 소스 선택 스위치**를 둔다. `_auto.json` 이 존재하고 스위치가 **명시적으로 켜져 있을 때만** 그것을 읽는다.
**자동 전환 금지.** 현재 어느 소스가 정본인지 **UI 에 항상 보이게** 한다.

### D-3' slot_setup 재구성은 기존 경로 재사용
기존 `loadRoiToDb`(웹 `cap-load-roi`, "PtzCamRoi.json → slot_setup 전량 재구성")가 이미 그 일을 한다.
**소스 파일만 교체 가능하게 확장**해 재사용한다. `replaceSlotSetup` **신규 호출자 증가 0**.
(이 저장소에는 "검출 없는 finalize 가 slot_setup 을 파괴한" 기존 이슈가 있다 — 신규 파괴 코드 금지.)

## Loop
1. 미리보기 UX 수정 → 선택 없으면 버튼 비활성 + 사유, 선택 시 활성. 정적 봉인 테스트
2. `_auto.json` 쓰기 전환 → apply 후 `PtzCamRoi.json` **바이트 무변경**을 테스트로 봉인
3. 소스 선택 스위치 → off 면 기존 동작 **완전 동일**(회귀 0), on 이면 `_auto.json`
4. 승인 → slot_setup 전량 재구성 → 행 수·순서·globalIdx 일치. **빈 소스·개수 0 이면 거부**(DB 무변경)
5. 리더가 라이브 라우트(13020)로 종단 확인

## Requirements (불변 제약)
- [ ] **기존 수동 경로 회귀 0** (스위치 off = 완전 동일) ← 최우선
- [ ] 파괴 방지: 빈 소스·슬롯 0 이면 재구성 **거부** + DB 무변경. 되돌리는 법 문서화
- [ ] 자동 전환 금지 — 소스 전환·재구성은 **명시적 사용자 트리거로만**
- [ ] 결정론 · `round5`/`stringify5` · **throw 금지(→ null + issues)** · 순회 순서 고정
- [ ] `groundModel.ts`/`project.ts`/`ground/types.ts`/`floorRoi.ts`/`web/core.js` 무변경 목표.
      `Finalizer.ts`/`SqliteStore.ts` 는 불가피 시 **손대기 전 사유 보고**
- [ ] 직전 L3 테스트(골든 해시 포함) 유지. `tsc --noEmit` 0에러 + `vitest run` 전량 통과
- [ ] 요청 범위 밖 리팩토링 금지
- [ ] CLAUDE.md 5대 규칙

## 직전 라운드에서 이월된 미검증 (그대로 유효)
- **브라우저 실렌더 미확인** — 이번에도 `web/app.js` 를 건드리므로 미검증 면적이 또 늘어난다
- `allowNew` UI 미노출 → 웹 경로는 기존 슬롯 좌표 교체만 가능
- `ON_LATTICE_MAX_M=0.25`/`MATCH_MIN_IOU=0.5` 는 Unity 튜닝값 — 실카 재조정 필요
- 모든 IoU 1.0 류 수치는 Unity 픽스처 기준 — 파이프라인 무손실만 증명
