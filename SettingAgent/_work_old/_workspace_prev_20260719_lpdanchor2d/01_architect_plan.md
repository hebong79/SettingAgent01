# 01 architect plan — discovery 현재 프리셋 한정 + LPD 박스 표시

풀 설계서: `docs/20260719_193910_discovery_현재프리셋한정_박스표시_설계서.md`

## Goal (관찰형)
콤보 "앞면중심 LOOP"(discovery)를 (a)순수 LPD·(c)VPD→LPD 와 정합:
1. **현재 프리셋만** 검사(현재: 카메라 전체·전 슬롯 순회).
2. **검지 LPD 박스**를 현재 프리셋 오버레이로 표시(현재: 진행바·요약만).

## 확정 결정
- **G1 방식 (a)**: `/discover/ptz` body 에 `cam`/`preset` 옵셔널 추가 → `PlateDiscoveryJob.start`가 `camIdx===cam && presetIdx===preset` 필터(기존 slotIds 필터와 같은 자리, `expandDiscoveryTargets` 불변). 옵셔널 → 미전달 시 전체 배치 보존(회귀 0).
- **G2 완료 후 일괄**: `GET /discover/result` items 의 `found+lpdOrig`(원본 프레임 정규화 OBB, 라이브 LPD 와 동일 좌표계) → `state.discoverByKey[presetKey]` 저장 → `drawDetectOverlay` 에서 `#roi-plate` 게이트로 `drawPlateQuad` 렌더. done 전환의 기존 `startLive`→`drawRoiOverlay`가 트리거.
- **MCP 경계**: 둘 다 결정형(도구). 순수 비교 필터 + 이미 산출된 quad 렌더. LLM 무관.

## 단계 → 검증
1. 백엔드 필터: discoverRoutes StartBodySchema +cam/preset, `start(parsed.data)`; PlateDiscoveryJob.start(filter 객체)+cam/preset 블록 → **검증**: vitest `start({cam,preset}).total`==해당 프리셋 슬롯수, `start({})` 전체 보존, 잘못된 타입 400
2. 프론트 G1: discStart body `{}`→`{cam,preset}`(runLiveDetect 미러) → **검증**: 라이브 total==현재 프리셋 앞면중심 슬롯수
3. 프론트 G2: state.discoverByKey 초기화 + renderDiscResult result 파싱·저장 + drawDetectOverlay quad 렌더 → **검증**: 완료 후 현재 프리셋에 노랑 quad, #roi-plate 해제 시 은닉, 프리셋 전환 정합(sharp)
4. 회귀: `npx tsc --noEmit` 0, vitest 전량, (a)(c)·수집·센터링·상호배타·slot_setup.lpd 부분 UPDATE 불변

## 영향 파일 (구현자·문서화)
- 수정: `src/api/discoverRoutes.ts`, `src/calibrate/PlateDiscoveryJob.ts`, `web/app.js`(discStart·state·renderDiscResult·drawDetectOverlay), `test/discoverRoutes.test.ts`
- **불변**: `plateDiscoveryWriter.ts`(expandDiscoveryTargets)·`plateDiscovery.ts`·`types.ts`·`PtzCalibrator.ts`·`web/index.html`·`core.js`

## 구현 체크리스트
- [ ] discoverRoutes.ts: StartBodySchema cam/preset(z.number().int().positive().optional()), `start(parsed.data)`
- [ ] PlateDiscoveryJob.ts:111 `start(filter={})` 객체화 + cam/preset 필터(slotIds 앞), 이하 불변
- [ ] app.js discStart: cam/preset 해석·body JSON, total=0 문구 "현재 프리셋에…"
- [ ] app.js state:99 `discoverByKey: {}`
- [ ] app.js renderDiscResult: `/discover/result` 파싱 → found+lpdOrig 프리셋키별 → `state.discoverByKey` 대체
- [ ] app.js drawDetectOverlay showPlate 블록 끝: `state.discoverByKey[key]` quad 들 drawPlateQuad(_,_,false)
- [ ] test: cam/preset 필터 케이스 가산
- [ ] tsc 0 + vitest 전량 + 리더 라이브(total·박스 정합·회귀)

## 가정/미해결 (리더 확인 여지)
- A: "현재 프리셋" = `capFrameKey2 ?? state.cam/preset`(runLiveDetect 동일).
- B: 완료 후 일괄 표시(실시간 발견분 아님).
- C: discovery 박스 = 라이브 LPD 와 동색(노랑). 시각 구분 미도입.
- D: discoverByKey 매 완료 시 **대체**(누적 아님) — 이전 프리셋 잔여 정리. 다중 프리셋 누적 원하면 병합으로.
