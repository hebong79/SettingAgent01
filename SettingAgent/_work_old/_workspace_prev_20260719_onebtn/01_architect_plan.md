# 01. 설계 계획 — 원버튼 셋업 파이프라인 (수집→최종화→센터라이징 자동 연쇄)

**정본 설계서**: `SettingAgent/docs/20260719_130352_원버튼셋업파이프라인_설계서.md` ← 상세는 전부 여기. 본 문서는 요약+체크리스트.

## 핵심 결정 (설계서 §2~§3)

1. **오케스트레이션 = 백엔드**. 최종 소비자가 주차장관리 에이전트(MCP/헤드리스)라 프론트 체인(b)은 목표 미달. 백엔드 수정도 "옵셔널 콜백 2개 + 신규 클래스 1개"로 외과적.
2. 방식: 신규 라우트 대신 `POST /capture/start` 바디 `autoChain?: boolean`(기본 false, 명시적 옵트인). 체인 상태는 신규 `GET /capture/pipeline` (기존 status shape 불변).
3. 신규 `src/pipeline/SetupPipeline.ts` — 이 3단계 전용 인메모리 상태머신(범용 워크플로 엔진 금지). idle→capturing→finalizing→calibrating→done|failed. **비무장 시 콜백 전부 no-op**(수동 흐름 구조적 보존).
4. 완료 훅: CaptureJob·PtzCalibrator 에 옵셔널 `onFinished` 콜백 가산(각 ~5줄, throw 흡수). index.ts 에서 클로저 전방참조로 배선.
5. 가드 3종(위장 성공 금지):
   - dets 0 → **finalize 미호출** 정지(replaceSlotSetup DELETE+INSERT 파괴 방지 — F10)
   - finalize throw → calibrate 미발화·failed{finalize}
   - LPD 타깃 0 → **calibrator.start 미호출**(빈 slot_ptz.json 덮어쓰기 방지 — F6 신규 발견) → done+note
6. LPD 홀 정직 리포트: coverage `{targets, totalSlots, uncovered}` — 근본 해결(A2 앞면중심 prior)은 범위 밖 후속(설계서 §5.2).

## 구현 체크리스트 (developer)

- [ ] 1. `src/pipeline/SetupPipeline.ts` 신규 + `test/setupPipeline.test.ts` T1~T8 → vitest green
- [ ] 2. CaptureJob/PtzCalibrator 옵셔널 `onFinished` + 흡수 테스트 T9 → **기존 테스트 무수정 green**
- [ ] 3. captureRoutes(autoChain 스키마·isBusy 409 가드·onCaptureStart 배선·GET /capture/pipeline) + server.ts/index.ts 조립 + 라우트 테스트
- [ ] 4. web/index.html 체크박스 `#cap-autochain`(기본 OFF) + app.js(capStart 바디·pipeline 폴 렌더·finalizing→calibrating 전환 시 오버레이 갱신)

## 영향 파일 (documenter 전달)

- 신규: `src/pipeline/SetupPipeline.ts`, `test/setupPipeline.test.ts`
- 수정: `src/capture/CaptureJob.ts`, `src/calibrate/PtzCalibrator.ts`, `src/api/captureRoutes.ts`, `src/api/server.ts`, `src/index.ts`, `web/index.html`, `web/app.js`, `test/captureRoutes.test.ts`(가산)
- 무변경: tools.config.json, DB 스키마, slot_ptz.json shape, CaptureStatus/CalibrateStatus shape

## 검증 (qa-tester + 리더)

- vitest: 설계서 §6a T1~T9 + 라우트 3케이스. 회귀 0 = 기존 테스트 무수정 통과.
- 라이브(13020): 설계서 §6b L1~L6 (체인 실동작 / dets0·finalize throw 실패 주입 시 중단·DB 보존 / 수동 3버튼 회귀 0 / 수동 정지 취소).

## 가정·미해결 (설계서 §8)

- 옵트인은 요청 단위 플래그(영속 설정 안 함). 수동 stop=체인 취소(failed{capture,'stopped'}). 자동 체인 finalize 는 logicOccupancy 미전달(정상). slotIds 부분 센터링은 수동 경로 소유.
- 후속: 수동 경로 stale slot_setup 가드, A2 전슬롯 커버.
