# 04. 문서화·영향도 요약 — 24회차 관측원 이미지유래 교체

- 최종 문서: `docs/20260730_234500_24회차_관측원_이미지유래교체_방위붕괴.md`

## 핵심 요약

Q1 FAIL. 설계자 예측 4항목(재현율 `0.60~0.78`/정밀도 `0.75~0.90`/편의 방향 아래쪽/편의 크기 `10~30px`) 전부 빗나감 — 실측 재현율 `0.04878048780487805`, 정밀도 `0.0625`, 편의 방향 위쪽(중앙값 `-85.1104482577656px`), |편의| 중앙값 `101.66977056400071px`(60px 붕괴선 초과).

**진짜 원인은 설계자가 예측 축에 넣지 않은 양** — 길이축 방위 오차(중앙값 `31.052940498468203`도·최대 `81.20361214245227`도). 사선 시점에서 마스크 하단은 「앞범퍼+옆면 사이드실」의 L자인데, `nearEdgeOf()`의 좌우끝 연결이 그 L자를 가로지르는 현(chord)을 만들어 면 전체가 회전했다. 설계자가 붕괴 분기에 적은 원인("마스크 하단이 접지가 아니다")은 틀렸음을 스샷(`r24_rawmask_2_2_0cf4fda4d3aa.png`)으로 반증.

**24회차 실제 산출물** — 미회수 면 원인 분해: VPD seg 기하 결손 34/39(`0.8717948717948718`), 검출 미탐 5/39(하드 실링 41−36과 정확히 일치). → 25회차는 검출기가 아니라 기하(비-오라클 방위 부트스트랩)를 봐야 함.

**신뢰 근거**: Q3(강등본 소스 비트 동일: outputs 42·faces 39·recall `0.9512195121951219`·precision `0.9285714285714286`) PASS, Q4(상한 정합, 오라클 누출 없음) PASS → 낮은 성적은 배선 오염이 아니라 관측원 자체 성적임이 담보됨.

## 영향도

- `src/ground/*` · `src/rpc/services/*` · `web/*` — **0줄**(`git status --porcelain` 실측 재확인, 빈 출력).
- `proposeFromObservation`(`individualEngine.ts:155`) — 한 줄도 미변경.
- `src/tools/carAnchorUpper.ts` — 타입 2줄만(`source` 유니온에 `'real-vpd-seg'|'real-lpd'` 추가, `confidence?: number` 추가). 이 파일은 git 미추적(`??`)이라 diff가 무용 — 무해성은 Q3 비트동일·전체 스위트 green·변경 라인 명시의 3중 증거로 대체.
- 신규: `src/tools/imageObservation.ts`(신규 기하는 `nearEdgeOf` 12줄 + `footprintFromContact` 14줄뿐) · `src/tools/groundErrProbe.ts`(계측 전용) · `test/imageObservation.test.ts`(7개).
- 수정: `src/tools/individualEngine.ts`(`--source` 배선, `GateParams.minConfidence`), `test/individualEngine.test.ts`(2줄).
- `@parkagent/types` · REST 계약 · MCP 도구 스키마 — 미접촉. ActionAgent/DMAgent로 전파되는 영향 없음.
- 정본(`PtzCamRoi.json`)·DB(`setting.sqlite`)·`config/` — 읽기만, 쓰기 없음. `roi.auto.apply` 0회. **카메라 물리 이동 0회**(골든 JPEG 파일만 읽음). 검출 응답은 `reports/detcache_r24/` 10개로 캐시해 결정성 확보.
- VPD seg 소스는 계측 전용 — 실카 셋업 경로 배선 금지 규약 준수(auto-memory `vpd-auto-detect-forbidden`).

## 검증 인용

- `npx tsc --noEmit` exit 0.
- `npx vitest run` 296파일 / 3757테스트 전부 green(신규 +1파일/+7테스트, 기준선 295/3750과 정확히 일치, 실패·스킵 0).
- 골든 rows diff 0줄(recall `0.5853658536585366`·precision `0.8571428571428571`·meanIoU `0.8886003068644802`·minIoU `0.6130202566182261`·pass95 `8`·pass98 `1`, frameHash 5개).

## 확인 필요/미확정

- 게이트 `minConfidence` 실효 문턱 — 미도출(참 표본 2건, 「참을 하나도 안 죽이는 최대값」 규칙의 분포 근거 불성립). 효과 0 → 안 넣는 것이 결론.
- `SlotAxes` 비-오라클 부트스트랩 — 설계 범위 밖, 25회차 최우선 과제로 이월.
- 실카 σ — 여전히 미측정(시뮬 골든 실측만).
- 접지선 오차 실측의 짝짓기는 근사(근변 중점↔접지사각형 중심 최근접) — 밀집 프레임 오짝 가능성, dy 과대평가 여지.
