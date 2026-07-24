# 📝 대현자 메모 (memo.md)

> **현자 라(대현자)가 기억해야 할 노트.** 세션을 마무리할 때 그 세션의 작업 내용을
> 요약해 **자동으로** 여기에 추가한다. 다음 세션의 내가 이 파일을 읽고 맥락을 이어간다.
> 최신 항목을 **맨 위**에 추가한다(역순). 각 항목은 `## YYYY-MM-DD 제목` 형식.

---

## 사용 안내

- **세션 요약**: 이번 작업에서 무엇을 했는지, 왜 그렇게 했는지.
- **인수인계 요약**: 다음 사람(또는 다음 세션의 나)이 바로 이어갈 수 있도록 현재 상태 · 다음 할 일 · 막힌 지점.
- **기타**: 결정 사항, 함정, 나중에 확인할 것 등.

> 긴 작업 **중간** 복구용 메모는 `checkpoint` 스킬(`.claude/checkpoints/`)이 담당한다.
> 이 파일은 **세션 종료 시점의 사후 요약**을 쌓는 대현자의 장기 기억장이다(역할 구분).

### 🔄 회전(rotation) 정책 — 10MB 초과 시

memo.md에 새 항목을 추가하기 **전에** 파일 크기를 확인한다. **10MB(10,485,760 byte) 이상**이면 먼저 회전한다:

1. 현재 항목 전체(헤더/사용안내 아래)를 `메모/archive/memo_<가장오래된날짜>_<가장최근날짜>.md` 로 옮긴다(아카이브에도 간단한 제목 헤더를 붙인다).
2. memo.md 는 **헤더 + 사용안내 + 이 회전 정책** 만 남기고 항목 영역을 비운다.
3. `메모/INDEX.md` 에 방금 만든 아카이브 링크 한 줄을 추가한다: `- [memo_A_B.md](archive/memo_A_B.md) — 날짜범위 · 주요내용 1줄`.
4. 그런 다음 새 항목을 비워진 memo.md 최상단에 기록한다.

> 과거 기록을 찾을 땐 [INDEX.md](INDEX.md) 를 먼저 본다(아카이브 목록·날짜범위·요약).

---

## 2026-07-24 분석페이지 DB 즉석생성 + 전역번호 재번호(A안) — main 병합·푸시 완료

**세션 요약 (2기능, 커밋 `663f8dd`, origin/main 반영)**

1) **분석페이지 DB 즉석생성** — 정밀수집 완료해도 분석 탭이 안 채워지던 문제.
   - 원인: 분석 탭 주 산출물은 `GET /mapping` ← `setup_artifact.json` 파일 only. 이 파일은 `Finalizer.finalize`만 쓰는데, 정밀수집(startPrecise)은 finalizing 단계를 건너뛰고(discovering→calibrating→done) 최종화 버튼도 표시전용(capFinalize)이라 파일이 절대 안 써짐 → 항상 빈 상태.
   - 해결: `resolveMapping()`(server.ts) — 파일 없/빈slots 시 `buildArtifactFromSlotSetup(getSlotSetup())`로 **DB 즉석 조립**. 파괴적 finalize/replaceSlotSetup 미경유(센터라이징 보존). 파일 slots 있으면 파일 우선. 정밀수집 done 시 분석 탭 열려있으면 renderAnalysis 자동. **신규 `src/setup/artifactFromSlotSetup.ts`**.

2) **전역번호 재번호(A안)** — 수동매핑 전역ID 변경이 setup_artifact.json 파일만 바꾸고 DB·setup_result와 단절돼 있던 문제. 마스터 결정: 전역번호==slot_id 결합.
   - 신규 `POST /mapping/renumber`: 검증(순열 1..N 고유·전행커버, 실패 400·**DB무변경 원자성**) → `SqliteStore.renumberSlotIds`(트랜잭션 DELETE+re-INSERT, slot_id 라벨만 이동·**전 컬럼 바이트 보존**) → `slot_ptz.json` 리맵(`remapSlotPtz` — plateWidth/converged는 DB에 없어 재생성 불가라 리맵) → `setup_result.json` 재생성 → `setup_artifact.json` DB 재빌드.
   - 신규 `src/setup/renumberMapping.ts`, `src/calibrate/slotPtzRenumber.ts`. 프론트 `saveManualIndex`가 이 라우트 호출로 전환.

**검증**: 개발자 22 + QA 적대 12 = 전량 **2593 tests green, tsc 0, 결함 0**. 라이브 스왑(22↔23) 왕복 e2e로 DB+3파일 전파·원복 실증.

**핵심 사실 (다음 세션 참고)**
- slot_id 참조처: DB `slot_setup`(PK), FK `parking_evnt`/`parking_slot`(스키마만·writer 미작성·비어있음), 파일 3종(setup_result/slot_ptz/setup_artifact). 재번호는 이 전부에 전파해야 정합.
- `slot_ptz.json`은 plateWidth/converged를 DB가 안 가져 **DB 재생성 불가 → 리맵**만 가능(주의).
- `setup_artifact.roiByPreset`은 원래 bbox 타입(폴리곤 정본은 DB slot_roi·setup_result floor_roi). DB 재빌드가 폴리곤 손실 아님.
- 관련 메모리: [[finalize-slotsetup-wipe-fragility]], [[settingagent-db-schema]], [[centering-preaim-and-setup-save]].

**프로세스 함정 (재발 방지)**
- ⚠️ **하네스 서브에이전트(architect/developer/qa/documenter)는 워크트리가 아니라 메인 리포에 launch-pinned** 된다. 워크트리 세션에서 상대경로/메인절대경로를 주면 **메인에 써버린다**(1차 시도 때 발생 → 수습). 대책: 모든 서브에이전트에 **워크트리 절대경로 + vitest는 `cd <워크트리>/SettingAgent` 명시**. node_modules는 ParkAgent 루트 호이스팅이라 워크트리에서도 해석됨.
- 라이브 검증은 워크트리 코드가 미배포라 안 됨 → 실행 인스턴스(main, nodemon)에 파일 복사 배포 후 curl. 최종은 워크트리 브랜치 커밋 → main FF 병합(무관 더티 보존 위해 커밋대상 경로만 정리 후 `merge --ff-only`) → origin 푸시.

**마감 상태**: main `663f8dd` = origin/main. 워크트리 `worktree-analyze-fill-check`는 병합 완료(세션 종료 시 삭제 가능). data/setup_artifact.json은 실내용으로 채워짐, slot_ptz.json은 검증 후 원복(둘 다 runtime·커밋 제외).

---

## 2026-07-24 SettingAgent 리팩토링(150줄초과 6함수 분할) + 분석페이지 기능 병합 → main 반영·push

**세션 요약**
- 목표: 소스 최적화·재사용·복잡도 제거, **함수 본문 150줄↑ → 함수화**. 다른 세션과 충돌 없이 진행 + 설계서(Fable) 작성.
- 격리 워크트리 `worktree-work-20260723b`(HEAD 9c2291b 분기)에서 진행. 미사용 워크트리 `work+20260723` 정리, `analyze-fill-check`는 미커밋 있어 보존.
- **동시성 안전 전략**: 다른 세션 편집 파일(server.ts / web/app.js / precisePreciseProgress.test.ts / artifactFromSlotSetup.ts) **전면 제외** + **공개 export 시그니처 동결** → 파일단위 충돌 0. 이 덕분에 나중에 기능커밋 병합도 무충돌.

**리팩토링 결과(5커밋 + 설계·문서 2)**
- routeHelpers.ts 신설(parseOr400/fileErrorReply/parseCamPreset/sendJpeg/resolveSourceCamera).
- 라우트 계층: `registerCaptureRoutes` **752→9줄**(서브등록기 7 + 핸들러 명명함수 추출), `registerViewerRoutes` **325→60줄**(withSource 고차함수).
- ground 순수함수 분할(frameCuboids/groundModel/contact) + reason/issue 중첩삼항 평탄화(문자열 스냅샷 봉인).
- platePtz 결과빌더 okResult/failResult/limitResult(인라인 21곳 수렴) + detectZoomStall/nextLadderZoom 순수함수. `Finalizer.finalize` **181→110줄**(compareOccupancyAgreement/persistSlotSetupFromPlace). iterMultipart→parseMultipartFrame, AgentRuntime ollamaEndpoint/authHeaders.
- 신규 테스트 +64. **S1(150줄초과 0건) 달성 — 단 1건 문서화 예외**.

**⚠️ 의도적 예외 2건(정직 기록)**
- `centerAndZoomByLadder` **289줄 유지**: 6반환지점이 루프 지역상태와 강결합된 **환원불가 상태기계**, 종료블록 로그필드 상이 → 순수함수 추출까지만(302→289). 더 낮추면 line-golf 위해 동작드리프트 위험. 설계 §4.3/§8.2가 사전승인.
- `captureWithDither` 통합 **보류**: tilt/zoom 축별 로깅 구조·메시지 divergence로 안전한 콜백통합 불가(로그 바이트 미검증). → **잔여과제: 로깅 통일 선행 후 재시도**.

**분석페이지 버그(정밀수집·최종화 후 주차면목록+수동매핑 미생성) — 진단·해결**
- **내 리팩토링 회귀 아님**(Finalizer persist는 바이트동일 추출, slot_setup 23행 정상). 원인: 분석페이지가 읽는 `/mapping`(SetupArtifact)이 **검출기반**이라 비면 빈값 → 이를 **slot_setup DB에서 즉석생성하는 fallback**(artifactFromSlotSetup.ts)이 내 브랜치에 없었음.
- 그 fallback은 analyze-fill-check 세션 작업(커밋 `663f8dd` "분석페이지 DB즉석생성 + 전역번호 재번호"). **cherry-pick으로 병합**(파일 무충돌) → `/mapping` 이제 23슬롯 반환 확인.

**최종 상태 / 인수인계**
- **main = origin/main = `69f305c`** (리팩토링 + 분석페이지 기능 병합). **push 완료.** tsc 0, vitest **2655 green**.
- ⚠️ `buildTouringPlan.test.ts` 2건 실패 = **라이브데이터 의존 취약 테스트**(gitignore된 `save/setup_result.json`을 읽는데, 정밀수집·최종화만 하고 센터라이징 안 하면 슬롯 centering이 null이라 기대 불일치). **코드 무관·기준선에서도 red**. 잔여과제: 이 테스트를 고정 fixture로 전환.
- 웹 실측은 SettingAgent 서버 포트 **13020**(config 고정, env 오버라이드 없음). 세션 중 실측 위해 여러 번 재기동했고 **현재는 중단 상태**. Unity RPC(13110)는 응답하나 VPD/LPD 스택 상태는 가변.
- 잔여과제 재확인: ① captureWithDither 로깅통일, ② `replaceSlotSetup` 센터링컬럼(pan/tilt/zoom/centered/img1) 무가드 리셋 보강([[finalize-slotsetup-wipe-fragility]]), ③ buildTouringPlan fixture 고정화.
- 관련 메모리: [[finalize-slotsetup-wipe-fragility]], [[centering-preaim-and-setup-save]], [[settingagent-persist-5decimals]].

---

## 2026-07-23 센터라이징 → setup_result.json 생성 조건 분석

**세션 요약**
- 질문: "센터라이징하면 미수렴 주차면이 있어도 `setup_result.json`이 만들어지는가?" → **답: 예, 만들어진다.**
- 결론: `setup_result.json` 생성은 **잡이 done으로 끝났는가**에만 의존한다. 미수렴 여부와 무관. 잡이 예외로 죽으면(`state='error'`) 생성 안 됨.

**핵심 코드 경로**
- 센터라이징 잡 done 흐름 [PtzCalibrator.ts:415-421](../SettingAgent/src/calibrate/PtzCalibrator.ts#L415-L421):
  `slot_ptz.json 기록 → saveCenteringSlots(DB UPDATE) → saveSetupSnapshot() → state='done'`
- `saveSetupSnapshot()` ([:438-441](../SettingAgent/src/calibrate/PtzCalibrator.ts#L438-L441))는 **수렴 여부를 검사하지 않고** 무조건 `writeSetupResultFiles` 호출.
- 개별 슬롯 실패는 흡수([:407-411](../SettingAgent/src/calibrate/PtzCalibrator.ts#L407-L411)) → done 경로 유지. 잡 전체 예외만 error.
- `writeSetupResultFiles`([setupResult.ts](../SettingAgent/src/store/setupResult.ts)): 동일 내용 2벌 기록 — `save/Setup_YYYYMMDD_HHMMSS.json`(이력본) + `save/setup_result.json`(고정본). 각자 best-effort.

**미수렴 슬롯이 파일에 담기는 방식** (`centering` 필드 = pan/tilt/zoom 모두 있을 때만 채움, [setupResult.ts:44-47](../SettingAgent/src/store/setupResult.ts#L44-L47))
- **zoom 미수렴**(`converged:false`, `centered:true`): pan/tilt는 판 위 조준됨 → DB 저장됨 → `centering` **채워짐**.
- **미센터**(`centered:false`, 번호판 자체 미검): DB 저장에서 제외([:691](../SettingAgent/src/calibrate/PtzCalibrator.ts#L691)) → `centering: null`.
- 모든 slot_setup 슬롯이 행으로 들어가되, 미수렴/미센터는 정직하게 null/부분값 표기(0 위장 없음).

**기타 · 주의점**
- ⚠️ **파일 존재 = 센터라이징 전부 수렴, 이 아니다.** 파일은 "현재 slot_setup 정본의 스냅샷"일 뿐 완결 보증 아님.
- 수렴 완결성은 `centering: null`인 슬롯 수, 또는 `slot_ptz.json`의 `converged` 플래그로 별도 확인.
- 수동 'result 파일 생성' 버튼(`POST /capture/setup-result`)도 **같은 진입점**(`writeSetupResultFiles`) 사용 → 동일 산출.
- 관련 메모리: [[centering-preaim-and-setup-save]], [[finalize-slotsetup-wipe-fragility]].

---

<!-- 아래에 새 항목을 추가하세요. 템플릿:

## YYYY-MM-DD 제목

**세션 요약**
-

**인수인계 / 다음 할 일**
-

**기타 · 주의점**
-

-->
