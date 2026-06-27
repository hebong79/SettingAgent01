# 03. QA 검증 리포트 — 장기 관측·반복 수집 → SQLite 누적 → LLM 정밀 주차면

- 작성: 검증자(qa-tester) · 2026-06-25
- 기준: `_workspace/02_developer_changes.md`(인계 포인트 8개) + `01_architect_plan.md` + 설계서 §0.3(G1~G5)·§8(좌표 불변식)
- 방법: vitest, 외부 서버·LLM·카메라·VPD/LPD 모킹, SQLite `:memory:`/임시파일, 타이머 주입.
- 결론: **양쪽 전부 통과 · 회귀 0 · 좌표 불변식 충족. 구현 결함 0(재작업 불필요).**

---

## 0. 실행 결과 (수치 그대로)

| 대상 | typecheck | 테스트(이전→이후) | 회귀 |
|------|-----------|--------------------|------|
| SettingAgent | 통과(0 에러) | **81 → 156** (신규 +75, 24 파일) | **0** |
| SettingViewer | 통과(0 에러) | **62 → 84** (신규 +22, 9 파일) | **0** |

- `cd SettingAgent && npm run typecheck && npm test` → **24 files / 156 tests passed**.
- `cd SettingViewer && npm run typecheck && npm test` → **9 files / 84 tests passed**.
- CaptureJob/Finalizer 의 흡수·예외 경로에서 출력되는 warn/error 로그는 **의도된 결함 주입 테스트**(흡수/error 전이 검증)로, 모두 통과한 케이스다.

---

## 1. 작성한 테스트 목록

### SettingAgent (`SettingAgent/test/`)
| 파일 | 케이스 수 | 매핑 | 핵심 검증 |
|------|----------|------|-----------|
| `geometry.test.ts`(가산) | +4 | median | 홀/짝 길이, 정렬·원본 불변, 빈 배열=0 |
| `sqliteStore.test.ts`(신규) | 16 | G2 | 스키마 보장, 런 CRUD, 관측·검출 적재→`getDetectionsForRun`(round 조인), `getPresetRounds`(DISTINCT round), `replaceAggregatedSlots` 멱등(replace), snake↔camel round-trip, `updateAggregatedStatus`(좌표 불변), checkpoint/snapshot, 파일경로 디렉터리 자동생성·재오픈 |
| `aggregator.test.ts`(신규) | 14 | G3 | 안정 클러스터(support↑→candidate), 노이즈(support<min→rejected), minConfidence 필터, **중앙값 대표 bbox**, occupancyRate(distinct round 분자·0 division), 프리셋 분리, 멀리 떨어진 2클러스터, plate 귀속(내부/외부), 결정형 동일 출력, plate-only/빈 입력 |
| `captureJob.test.ts`(신규) | 9 | G1 | start→running·DB 생성, 중복 start throw, count 도달→done(stop_reason=count)·done_count·적재 4건, 라운드 사이 stop→stopped(manual)·다음 미예약, stop no-op, 프리셋 일부 실패 흡수, 라운드 예외→error, LPD 적재·LPD 실패 흡수 |
| `captureRoutes.test.ts`(신규) | 19 | 라우트 | start(200/zod 400/409), status/stop(400), finalize(409/404/200), runs/aggregate(200/404/400), **기존 /health·/mapping·/setup/* 회귀**, 의존성 미주입 시 라우트 미등록(가산 보장) |
| `checkpointFinalizer.test.ts`(신규) | 13 | G4·§8 | clusterRef/advisoryLines 순수헬퍼, **체크포인트 좌표 불변**(merges/rejects→status, bbox 동일), LLM off/미주입/예외 no-op, Finalizer 결정형 강등(candidate 채택·zone=cam{N}·report 없음·rejected 제외), **Finalizer 좌표 불변**(roi=대표 bbox), LLM zoneLabels/report 반영, LLM rejects 제외, finalizeCapture 예외 강등, 체크포인트 status 보존 |

### SettingViewer (`SettingViewer/test/`)
| 파일 | 케이스 수 | 매핑 | 핵심 검증 |
|------|----------|------|-----------|
| `captureProxy.test.ts`(신규) | 13 | G5 | status/runs/aggregate(GET)·start/stop/finalize(POST) 패스스루, 경로·메서드·**본문 전달**, :id 치환, 200/400/409/404 패스스루, 5xx→502, unreachable→502, 기존 /mapping 회귀 |
| `captureCore.test.ts`(신규) | 9 | G5 | captureProgress(percent·label·**0 division 방어**·100 클램프·undefined), mapAdvisory(배열 복사·없음→[]), pollPlan(running/stopping/finalizing 만 폴링·간격) |

---

## 2. 좌표 불변식(§8) 검증 결과 — **충족**

설계 핵심: "좌표는 검출+집계만 생성/수정, LLM 은 메타(status/zone/report)만". 다음을 명시적으로 단언했고 모두 통과:

1. **CheckpointReviewer**(`checkpointFinalizer.test.ts` "rejects/merges → status 갱신, ROI 좌표는 입력=출력 동일"):
   - `merges`(2번째부터)→`merged`, `rejects`→`rejected` 로 **status 만** 변경. 입력 슬롯의 `{x,y,w,h}` 와 DB 조회 결과 bbox 가 **정확히 동일**(`toEqual`).
2. **SqliteStore.updateAggregatedStatus**(`sqliteStore.test.ts`): status 컬럼만 UPDATE, 좌표 4필드 불변 단언.
3. **Finalizer**(`checkpointFinalizer.test.ts` "ROI 좌표는 집계 대표 bbox 그대로"):
   - LLM `zoneLabels`/`report_ko` 는 반영되되, `slot.roiByPreset['1:1']` = 집계 대표 bbox `{0.3,0.3,0.1,0.1}`(roiPadding=0) 와 동일. LLM 은 좌표를 만들거나 바꾸지 않음.
   - LLM `rejects`/`duplicates` 는 **채택 여부 메타**로만 작용(좌표 미생성).

---

## 3. 경계면(snake/camel·1-based·조인) 교차 비교 결과

| 경계 | 검증 | 결과 |
|------|------|------|
| detection(테이블, round 없음) ↔ DetectionRow(roundIdx 보유) | `getDetectionsForRun` 가 observation 조인으로 round_idx 부여 | OK(`sqliteStore.test.ts`) |
| aggregated_slot(snake: occupancy_rate/plate_x) ↔ AggregatedSlot(camel) | replace→get round-trip `toEqual` | OK |
| Aggregator presetKey `${cam}:${preset}` ↔ getPresetRounds 키 | 동일 포맷·occupancy 분모 일치 | OK |
| clusterRef `presetKey#clusterId` ↔ LLM merges/rejects 입력 | reviewer/finalizer 가 동일 ref 로 매칭 | OK |
| Finalizer slotId `c{cam}p{preset}s{pos}` ↔ FinalizeCaptureResult.zoneLabels 키 | `c1p1s1` 라벨 적용 확인 | OK |
| globalIndex.globalIdx | 1-based 부여 확인 | OK |
| Viewer 프록시 경로 `/viewer/api/capture/runs/:id/aggregate` → `/capture/runs/{id}/aggregate` | :id 치환·메서드·본문 패스스루 | OK |

---

## 4. 성공 기준(G1~G5) 매핑

- **G1**(반복 N + 수동 정지 잡): `captureJob.test.ts` — 상태머신 전이·count/manual/error·중복 거부·흡수. **충족**.
- **G2**(SQLite 적재/조회): `sqliteStore.test.ts` 16케이스. **충족**.
- **G3**(결정형 시공간 집계): `aggregator.test.ts` 14케이스(합성 데이터). **충족**.
- **G4**(체크포인트/최종 LLM + artifact): `checkpointFinalizer.test.ts` — 메타 반영·좌표 불변·강등·shape/saveArtifact/snapshot. **충족**.
- **G5**(Viewer 프록시·순수로직): `captureProxy.test.ts`/`captureCore.test.ts`. **충족**.

---

## 5. 발견 결함·수정

- **구현 결함: 0건.** 모든 신규 테스트가 구현을 수정 없이 통과. 통과 위장·테스트 느슨화 없음.
- 테스트 작성 중 자체 보정 1건(구현 무관): `captureCore.test.ts` 의 `@ts-expect-error` 지시문 제거 — `core.d.ts` 가 이미 타입을 제공하므로 불필요(미사용 지시문은 typecheck 에러). 직접 수정.

---

## 6. 미커버(범위 밖) — 명시

다음은 유닛/모킹으로 커버하지 않았으며 별도 동작확인이 필요(삭제·통과 위장 아님):

1. **실 PTZ·Unity 실서버 스모크**(설계서 §10-8, 인계 §8): 시뮬레이터(:13100) N=소수·짧은 주기 → 수집→집계→`/capture/finalize`→`/mapping` 정밀 결과. **미수행(외부 서비스 미가동)** — 유닛(모킹)만 완료.
2. **장시간 잡·DB 증가**(설계서 §11-3): 보존/정리 정책 범위 밖.
3. **재기동 복구**(running 중 프로세스 종료, §11-5): 범위 밖. 런 status='running' 으로만 남음, 정리 로직 미검증.
4. **브라우저 DOM/app.js 통합**(탭 전환·진행바·폴링 와이어링): core.js 순수로직만 검증. DOM 결합·실폴링 미커버.
5. **better-sqlite3 네이티브 로드**: 구현자 실측(프리빌트 로드 성공) 신뢰. 본 검증은 `:memory:`/임시파일 동작으로 간접 확인.
6. **newFacesRecentK 정교화**(인계 §2): 1차 단순화(현재 후보 면 수)를 그대로 전달하는 동작만 검증. 라운드별 신규 면 추적 로직은 미구현(후속).

---

## 7. 재작업 필요 여부

**불필요.** 구현 결함 0, 양쪽 회귀 0, 좌표 불변식 충족. 문서화 에이전트로 인계 가능.
미커버 항목(특히 §6-1 실서버 스모크)은 동작확인 단계에서 시뮬레이터로 별도 수행 권장.
