# 01 · 설계 계획 — 슬롯 앞면중심 기준 번호판 탐색·확대반복·역계산

> 공식 설계서(정본·상세): [../docs/20260719_153707_번호판탐색_줌반복_역계산_설계서.md](../docs/20260719_153707_번호판탐색_줌반복_역계산_설계서.md)
> 이 문서는 구현자·검증자·문서화용 요약 + 검증 체크리스트다.

## 핵심 결정(3줄 요약)
1. **디지털 크롭-줌 = 1차 코어(이번 구현)**, 광학 PTZ 줌 = 2차 에스컬레이션(설계만·후속). 원본에 작게라도 있는 번호판은 크롭-업스케일이 정확히 구제.
2. **역계산 = 아핀**: `orig = W.xy + q·W.wh` (크롭창 offset·size만; 업스케일 배율은 LPD 정규화가 흡수해 식에 없음 → 오차 0).
3. **조준점 = 저장된 `slot3dFrontCenter`**(검출 무관 기하, 이미 DB). discovery 시점 지면모델 재계산 없음. LLM 미사용(결정론).

## 단계별 계획 → 검증
1. `cropZoom.ts`(순수 아핀 `backmapQuad`/`computeCropWindow` + sharp `cropAndUpscale`) → **검증**: T-1 아핀 왕복 오차<1e-9, T-2 창 [0,1]클램프·aspect.
2. `plateDiscovery.ts`(`PlateDiscovery.discoverSlot`: Tier0 full→Tier1 crop 축소반복→역매핑) → **검증**: T-4 mocked LPD 로 tier/step·역매핑 박스·no_plate/no_anchor 경로.
3. 후보선택 `pickNearestPlate` 재사용 + matchRadius/크롭게이트 → **검증**: T-3 이웃 배제.
4. (Phase 2) `PlateDiscoveryJob` + `discoverRoutes` + `SqliteStore.upsertSlotLpd`(slot_id 부분 UPDATE, **DELETE+INSERT 금지**) → **검증**: 잡 상태·JSON 정본·slot_setup.lpd 채움(회귀0).
5. (b) 리더 sharp 합성 파리티: 심어둔 작은 번호판에 역매핑 박스 정합.
6. (Phase 3·후속) 광학 tier: PlatePtz 재사용 + `projectToPixel(backproject(p,G_i),G0)`. `G_i` 유도 미확정 → 리포트만(`reason:'needs_optical'`).

## 영향 받는 파일/모듈
- **신규**: `src/calibrate/cropZoom.ts`, `src/calibrate/plateDiscovery.ts`, `src/calibrate/PlateDiscoveryJob.ts`, `src/api/discoverRoutes.ts`, `test/cropZoom.test.ts`, `test/plateDiscovery.test.ts`.
- **수정(가산·외과적)**: `src/calibrate/types.ts`(PlateDiscovery* 타입), `src/capture/SqliteStore.ts`(`upsertSlotLpd`), `src/index.ts`(라우트·잡 배선, Phase 2), `data/plate_discovery.json`(신규 산출), `config/tools.config.json`(선택).
- **재사용 무수정**: `project.ts`(광학만), `LpdClient`, `CameraClient.requestImage`, `detectPipeline.resolvePresetPtz`, `controlMath.pickNearestPlate`, `PlatePtz`(광학), `SlotSetupView.slot3dFrontCenter`.

## MCP 도구 vs LLM 두뇌 경계
- **전부 결정형 도구**(수치·기하·검출). LLM **미사용** 확정(마스터 제약). 크롭·아핀·최근접·상태전이는 결정론 루프.

## 산출물 계약(요지)
- 슬롯별 `{ found, lpdOrig(원본 정규화 OBB|null), tier:'full'|'crop'|'optical', step, cropWindow?, ptz?(광학), confidence, reason? }`.
- 흐름: `plate_discovery.json`(정본) + `slot_setup.lpd`(원본좌표, 부분UPDATE) → **센터링(PtzCalibrator)의 상류**. discovery 가 lpd 를 채워 `expandPlateTargetsFromSlotSetup` 의 검출 의존 누락(과업 A2) 해소. 센터링 확장 아님·별개 선행 잡.

## 명시적 한계(문서화 전달)
후면주차(앞면중심 가정 붕괴), 번호판 세로오프셋/차종별 높이(넉넉한 창으로 흡수), 앞면중심 부재 슬롯(`no_anchor`), 광학 역계산 오차(후속), 못 찾은 슬롯 정직 리포트.

## 미해결/가정(리더 확인)
1. 광학 `G_i` 유도 미확정 → **디지털만으로 1차 마감, 광학은 별도 goal/loop** 분리 권고.
2. 크롭 중심 = 앞면중심 그대로(1차) vs 번호판높이 하향보정(보류).
3. **Phase 1(알고리즘+테스트) 우선 착수** 권고 → Phase 2(잡·라우트·DB) → Phase 3(광학).
4. frac0=0.40/shrink=0.6/minFrac=0.05/maxSteps=5/matchRadius=0.15 = 눈대중 초기값, QA 미세조정.
