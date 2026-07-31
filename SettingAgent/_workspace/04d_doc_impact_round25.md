# 04d. 문서화·영향도 요약 — 25회차 야간 오검출·전경 역전

- 최종 문서: `docs/20260731_004500_25회차_야간오검출_전경역전_후보진입컷.md`
- 근거: `_workspace/31_architect_plan_round25_night_falsepositive.md` · `_workspace/32_developer_night_falsepositive_round25.md` · `src/tools/gridDiag.ts` · `git diff src/ground/bayGeometry.ts src/ground/bayGrid.ts` 직접 확인 · `reports/overlay_r25a/` 스샷 육안 확인

## 핵심 요약

**목표(야간 오검출 0) 미달성.** 설계자 1·2순위 가설 모두 실측 기각:
- `cellAreaRatio` 축은 격자가 `slotWidthM×slotDepthM`로 세워진 뒤 같은 모델로 역투영되므로 지상 면적이 정의상 규격으로 되돌아온다. `|ratio−1|` 최대 시뮬 `5.218048215738236e-15` / 야간 `7.327471962526033e-15` — 어떤 값을 넣어도 못 가른다.
- 최우선 용의자 `paintTolPx=6`: 기전(거리비례 관용도, 시뮬 tolM 6.505배 폭)은 실재하나 야간 `near~tolM` r²=0.039(부호 반대)로 설명력 없음. 지배 성분은 H2(야간 `near~quads.length` r²=0.804, H3 대비 21배 차이).

**실제 산출**: 「전경 역전」의 원인은 점수식이 아니라 **`frontCandidates=8`(도색선 후보 진입 상한)**. 시뮬 1:1은 60개 검출 직선 중 8개만 채점되고 그 8개(depth 21.4~99.2m)에 전경 근변선이 없다 — 22회차 EV5(rank#11)와 같은 병목.

**반증**: 야간 「거대 사각형」라벨이 전부 `1.00` — tilt 7.86°(거의 수평)에서 역투영이 픽셀만 팽창시키고 지상 면적은 정의상 불변. `cellAreaRatio`는 붕괴한 모델 자신으로 재므로 깊이 붕괴를 볼 수 없다.

**신규 가설(리더, 미측정)**: OSD 자막이 도색선으로 오검출된다 — 야간/EV4/EV5 육안 교차 3건. 26회차 표적.

**정직 고지**: 마스터 스샷 7장 재현 불가(frameHash 0건, 프레임 미저장). 야간 6프레임은 real-camera-2(마스터는 real-camera-1)이고 주차장 아닌 벽면+글레어+자막 — 「EV3 재현」아님. 무이동 신규 캡처 없음. Q6(플래그 ON 골든)은 `roiAutoRecall` 미사용, `gridDiag` OFF/ON JSON 바이트 동일로 대체. H5(야간 노출) 미측정. §5-3 승격 조건 (a) 불충족 → 플래그 기본값 승격 제안 안 함.

## 영향도

- **23·24회차와 달리 서비스 경로 접촉**: `git status --porcelain -- src/ground src/rpc/services web` → `bayGeometry.ts`·`bayGrid.ts` **2개만**.
- `src/rpc/services/roiAuto.ts` — `cellAreaRatio` 문자열 **0건**(테스트 봉인), `BaseSchema`(`roiAuto.ts:57-81`) 무수정.
- 배선 4지점(21회차 `rowExtentMode` 규약과 동형):
  1. `BayDetectOpts`(`bayGeometry.ts:202-215`) — `cellAreaRatioMin?`/`cellAreaRatioMax?` 필드 2개 추가
  2. `DEFAULT_BAY_OPTS`(`bayGeometry.ts:278-280`) — 무력 기본값 `0`/`Infinity`
  3. `bayGrid.ts`(신규 `quadGroundAreaM2()`·`cellAreaRatioOf()`) — 기존 `backprojectToGround` 재사용, 새 기하 근사 없음
  4. `bayGrid.ts:383-388`의 `kept` 필터 — 조건 1개(`ratioOk(e.q)`) 추가. 점수식(`:457-458`)·`refScore`(`:687-695`)·`rows` 문턱(`:696-699`) 무수정
- **기본값이 무력이라 골든 무회귀는 측정이 아니라 구조적 보장.**
- 신규: `src/tools/gridDiag.ts`(438줄, 계측 전용) + `test/gridDiagWiring.test.ts`(6 테스트).
- 정본·DB 무접촉(`data/setting.sqlite`·`PtzCamRoi.json`·`config/` 쓰기 0), `roi.auto.apply` 0회, **카메라 접촉 0회**(디스크 JPEG 11장만 입력, 캡처 클라이언트 import 0, 소스 문자열 봉인 테스트).
- `@parkagent/types`·REST 계약·다른 에이전트(ActionAgent/DMAgent) — 접촉 없음.

## 검증(문서화 담당 재실행)

- `npx tsc --noEmit` → **exit 0**(재실행 확인, developer 보고와 일치)
- `npx vitest run` → **297 파일 / 3763 테스트 전부 green**(재실행 확인, 기준선 296/3757 대비 +1파일/+6테스트로 신규분과 정확히 일치)
- 골든 rows 6지표(recall `0.5853658536585366` 등)는 **문서화 단계에서 재실행하지 않음** — developer 보고서 수치를 인용만 함(확인 필요 표시).
- 스샷 2장(`r25_base_sim1-1_*`, `r25_base_night...202543_*`) 육안 직접 확인 — developer 서술과 일치.

## 확인 필요

- `cellAreaRatioMin/Max`가 향후 서비스 오버라이드로 승격될 경우 `roiAuto.ts:956-962`·`BaseSchema` 양쪽 노출 필요(현재 미해당).
- 야간 자산 `.ptz.json` 부재 시 `manifest.json.viewerPtz` 대체 구성 규약이 다른 도구(`realFrameOverlay.ts`)와 완전히 일치하는지 개별 재검증 안 함.
