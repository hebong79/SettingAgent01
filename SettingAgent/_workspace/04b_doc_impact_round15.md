# 04b 영향도 분석 15회차 — 골든 v2 · 자가보정 증폭기 통제

- 작성: 2026-07-29 17:15 / 문서화(documenter)
- 대상: `src/tools/roiAutoGoldenV2.ts`(신규) · `src/tools/roiAutoFuse.ts`(수정) · `test/fixtures/roiAutoGolden_v2/`(신규 산출물) · `config/tools.config.json`(P0 변경, 마스터 승인)
- 근거: `_workspace/01b_architect_plan_round15.md` · `02o_developer_changes_round15.md` · `03b_qa_report_round15.md`
- 이 문서는 코드·정본·DB·config·픽스처를 **변경하지 않는다.** 문서만 작성한다.

---

## 1. 소스 변경 범위 — 도구 전용

| 파일 | 상태 | 영향 |
|---|---|---|
| `src/tools/roiAutoGoldenV2.ts` | 신규(167줄) | `npx tsx` 단독 실행 도구. MCP 신규 도구·RPC 메서드 추가 없음 |
| `src/tools/roiAutoFuse.ts` | 수정 | 지상고 정책 모드(A/A0/B/C) + 골든 세트 별칭(v1/v2) 추가. 주입 지점은 `detectBaysWithModel(..., { ...DEFAULT_BAY_OPTS, expectedBays, ...optOverride }, frame)` 객체 리터럴 1곳뿐 |
| `src/ground/*`(`bayGrid.ts`·`bayGeometry.ts`·`cameraIntrinsics.ts` 등) | **무변경** | 지상고 정책 주입은 `roiAutoFuse.ts`의 opts 오버라이드로 끝난다. `DEFAULT_BAY_OPTS` 자체도 무변경(다른 도구·서비스가 공유하므로) |
| `src/rpc/services/roiAuto.ts` | **무변경** | 서비스 배선은 16회차 이후. 이번 라운드 성공기준 미충족으로 배선 후보 자체가 없음(본문서 §6 문서 참조) |
| 정본(`data/Place01/PtzCamRoi.json`) · DB(`data/setting.sqlite`) | **무접촉** | 읽기만 함(`readFileSync`). `roi.auto.apply` 미실행 |

### 1-1. `roiAutoFuse.ts`를 쓰는 기존 흐름에 대한 영향

- **하위호환 확인됨**: 모드 인자를 생략하면(`npx tsx src/tools/roiAutoFuse.ts`) 14회차와 **바이트 동일**한 출력을 낸다(§4 참조). 접두(`[A ]`)·모드 배너는 모드가 1개일 때 붙지 않는다.
- 이 도구를 참조하는 다른 도구·서비스는 없음(진단 도구이며 서비스에서 import되지 않는다 — `src/rpc/services/roiAuto.ts`는 독립 구현).

---

## 2. 신규 픽스처 — `test/fixtures/roiAutoGolden_v2/`

| 항목 | 값 |
|---|---|
| 크기 | 11MB(30장 JPEG + `manifest.json`) |
| 파일 수 | 30 + 1 |
| Git 상태 | **미추적**(`git status` `??`). v1(`test/fixtures/roiAutoGolden/`)과 동일 취급 |
| 커밋 여부 | **미결(A4, 14회차부터 이월).** 마스터 결정 전까지 `git add` 금지 — 이번 라운드도 준수했다 |
| 회귀 영향 | `vitest.config.ts`의 `include`가 `test/**/*.test.ts`뿐이라 `.jpg`/`.json` 픽스처는 수집 대상이 아니다. `tsconfig.json`의 `include`도 `.ts` 파일 한정이라 무관. v2를 읽는 테스트를 신규로 추가하지 않았으므로(이번 라운드 계획 범위 밖) 3553개 테스트의 실행 시간·결과에 변화가 없다 |

### 2-1. v1 픽스처 무결성 (검증자 직접 확인, V4)

- 30장 sha256·bytes **manifest 대조 불일치 0/30**
- 총 바이트 **10,442,604B**(14회차 값과 일치)
- mtime 전건 `2026-07-29T04:38:23Z`(13:38 KST) — 이번 라운드 작업 전후로 **불변**
- `git ls-files` 0건 — 미추적 상태 유지

---

## 3. config 변경 — `real-camera-2` → `simulator-1`

### 3-1. 사실관계 (git 이력 대조로 확인)

| 시점 | `selectedCameraId` | `real-camera-2.password` | 비고 |
|---|---|---|---|
| **커밋 HEAD**(2026-07-28 18:04, `5d9aff5`) | `real-camera-1` | `""`(빈 값) | 정본 커밋본 |
| 12:46 변경(주체 미상, 14회차가 확인) | `real-camera-2` | `"mts6500!!!"` 추가 | 마스터의 실카 정찰 작업으로 추정(문서화 시점 확정 근거는 없음 — "확인 필요"로 표기) |
| **15회차 P0**(리더, 마스터 승인) | **`simulator-1`** | `"mts6500!!!"`(그대로 유지) | 이번 라운드는 골든 세트(v1/v2 정적 픽스처) 위주라 실질적 라이브 트래픽 영향은 제한적이나, 값 자체는 여전히 커밋본과 다르다 |

- `git diff HEAD -- config/tools.config.json` 확인 결과 현재 작업본은 커밋본 대비 `selectedCameraId: real-camera-1 → simulator-1`, `real-camera-2.password: "" → "mts6500!!!"` 두 줄이 다르다.
- **이번 15회차 라운드는 config를 직접 쓰지 않았다**(리더의 P0이 라운드 착수 전 별도로 승인·적용됨). 구현자·검증자 모두 "읽지도 쓰지도 않았다"고 명시했다(Q-f 준수).

### 3-2. nodemon 반영 여부 — 미반영 상태로 남아 있음

`nodemon.json`의 `watch`가 `["src"]`뿐이라 **`config/*`는 감시 밖**이다. 따라서 이번 P0 값 변경은 현재 구동 중인 프로세스(13020=`selectedCameraId` 최신 반영 여부 불확실, 13021)에 **즉시 반영되지 않는다.** 다음 자연 기동(수동 재시작) 시 반영된다. 이번 라운드는 서버 재시작을 0회 실행했으므로(§5 회귀 참조) 이 변경이 실제 런타임에 언제 반영될지는 다음 기동 시점에 달려 있다.

### 3-3. 실카 재개 시 되돌릴 항목 (16~17회차 인계 사항)

- 실카 재개 시 `selectedCameraId`는 `simulator-1`(현재)이 아니라 §12-③에서 권고한 **`real-camera-1`**로 전환해야 한다(`focalTrue` 표본 보유, U15 펌웨어 오차 회피).
- `real-camera-2.password`에 남아 있는 `"mts6500!!!"`(12:46 추가분, 커밋본에는 없음)은 **실카 재개 시 마스터에게 유지/제거 여부를 확인**해야 한다 — 이번 문서화 단계에서는 그 의도를 확정할 근거가 없어 "확인 필요"로만 남긴다.

---

## 4. 무회귀 재확인

| 항목 | 결과 |
|---|---|
| `npx tsc --noEmit` | exit 0(구현자·검증자 각각 재실행 — 일치) |
| `npx vitest run` | 281파일 3553테스트 전량 green — 구현자 18.33s, 검증자(독립 재실행) 17.67s |
| `roiAutoFuse.ts` 인자 없는 실행 | md5 `d8ac52be1561a61de50d397c0c9ce951`, 바이트 동일. **단 비교 대상은 "15회차에 새로 만든 사전 기준 로그"이지 14회차 원문 로그가 아니다** — `*.log`가 `.gitignore:24`로 배제되고 `roiAutoFuse.ts` 자체가 git 미추적이라 14회차 버전 자체가 복원 불가능하다(검증자 V3 확인). 간접 대조(`02n_developer_changes_round14.md:51`의 `1:1` 면별 수치)는 현재 출력과 일치한다 |

---

## 5. R1~R10 준수 판정표

| 제약 | 판정 | 근거 |
|---|---|---|
| **R1** 수동 정본은 채점 전용 | **준수** | v1/v2 모두 `manual`은 `scorePreset`(채점) 호출에서만 읽힌다. 검출·격자 선별·지상고 계산 어디에도 수동 정본이 입력되지 않는다 |
| **R2** 결정론(랜덤·RANSAC 금지, 동점 시 낮은 인덱스) | **준수** | `medianLow`(짝수 시 낮은 쪽), `vote()`의 군집 동점 해소(`Math.min(...members)` 우선) 모두 결정론적. 단 §7의 C `2:2` 붕괴가 바로 이 "낮은 인덱스 우선" 규칙에서 나온 부작용임을 QA가 규명(버그 아님, 규칙의 성질) |
| **R3** 정점 순서 하드코딩 금지 | **준수(무접촉)** | `canonicalizeQuad` 등 기존 함수 재사용, 신규 정점 순서 로직 없음 |
| **R4** `quadIoU` 등 기존 IoU 구현 재사용 | **준수** | `scorePreset`을 그대로 호출, 신규 IoU 구현 없음 |
| **R5** DB 쓰기는 `slot.roi.sync`만 | **해당 없음(무접촉)** | 이번 라운드는 DB를 읽지도 쓰지도 않는다 |
| **R6** 채점/미리보기와 apply 분리 | **준수** | `roi.auto.apply` 0회 실행 |
| **R7** 영속화 소수점 5자리 | **준수** | v2 manifest의 `ptz`/`presetPtz`는 정본 값 복사(신규 계산 없음), `settleMs`는 정수 — round5 대상 자체가 발생하지 않음(구현자·검증자 공통 확인) |
| **R10** 시뮬 수치로 실카 대변 금지 | **준수** | 본 문서·라운드 문서 모두 "v2도 시뮬의 정착본일 뿐 실카 검증이 아니다"를 명시. §12(P3)는 실행 0건으로만 보고 |
| 반증 목록(14회차 §16, 20건) 재시도 | **재시도 없음** | 증폭기 통제(P2)는 14회차가 "반증 목록에 없는 미탐색 항목"으로 명시한 건 |

---

## 6. 서비스·의존성 파급 — 확인 결과: 없음

- `@parkagent/types` 변경 없음.
- `SlotState`/`ParkingEvent` 등 공유 도메인 타입 변경 없음.
- REST 계약(`src/rpc/methods.ts`, HTTP 라우트) 변경 없음 — 이번 라운드가 건드린 두 파일은 모두 `src/tools/` 하위의 독립 실행 스크립트이며 서비스 계층(`src/rpc/services/*`)에서 import되지 않는다.
- ActionAgent·DMAgent 등 타 에이전트 코드베이스에 대한 영향 **없음**(SettingAgent 도구 레벨 변경으로 범위가 닫혀 있다).

---

## 7. 확인 필요 (단정하지 않음)

- **12:46 config 변경의 정확한 의도**: 마스터의 실카 정찰 작업으로 추정되나(14회차가 이미 이렇게 추정), 이번 문서화 단계에서 이를 확정할 추가 근거는 확보하지 않았다. 실카 재개 논의 시 마스터 확인 필요.
- **`real-camera-2.password` 잔존 여부**: 커밋본에 없던 값이 작업본에 남아 있다. 삭제할지 유지할지는 마스터 결정 사항으로 남긴다.
- **골든 v2 픽스처 커밋 여부(A4)**: 14회차부터 이월된 미결 사항이며 이번 라운드에서도 결정되지 않았다.

---

## 8. 요약

- 이번 라운드 변경은 **도구 레벨 2개 파일 + 픽스처 1세트**로 완전히 국소화되어 있다.
- 서비스·정본·DB·공유 타입 어디에도 파급되지 않는다.
- config 변경은 이번 라운드가 만든 것이 아니라 라운드 착수 전 리더가 승인한 P0이며, 그 이력(커밋본 대비 두 줄 차이)과 nodemon 미반영 상태를 그대로 기록해 둔다.
- 회귀는 tsc 0 · vitest 281파일 3553테스트 green(구현자·검증자 독립 재현 일치).
