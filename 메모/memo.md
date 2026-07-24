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

## 2026-07-24 DB 테이블 preset_pos → preset_info 리네임 + 누락필드 추가 — main 병합·푸시 완료

**세션 요약 (커밋 4개, origin/main `aa4d4a3` 반영)**

- 발단: 마스터가 `my_db_table.md`에 §camera_info·§preset_info 정의를 붙이며 "DB테이블 추가및 생성해줘".
- **선확인으로 방향이 바뀐 건**: `camera_info`는 **이미 스키마에 완전 존재**(§3 정의와 일치, +img_w/img_h)라 만들 게 없었고, `preset_info`는 기존 `preset_pos`와 pos가 중복이었다. 이 중복을 물었더니 마스터 결정 = **"preset_pos를 preset_info로 이름 바꾸고 없는 필드 추가 + 사용처도 수정"**.
- 확정 스키마: 테이블 `preset_pos`→`preset_info`, 컬럼 `sname`→`preset_name`(기존 sname이 곧 프리셋 라벨), 신규 `place_id`(기본 1), `pan/tilt/zoom` REAL 3컬럼 유지(pos용 JSON 컬럼 새로 만들지 않음), `slot_setup` FK 갱신. 타입 `PresetPosRow`→`PresetInfoRow`, 메서드 `upsertPresetPos`→`upsertPresetInfo`.

**핵심 기술 함정 2개 (설계 단계에서 잡음 — 그냥 짰으면 깨짐)**

1. **ensureSchema 순서 역전 필수**: 기존 DB에서 `CREATE TABLE IF NOT EXISTS preset_info`가 먼저 돌면 **빈 preset_info가 생겨** 뒤이은 `ALTER TABLE preset_pos RENAME TO preset_info`가 "이미 존재"로 실패. → 리네임 마이그레이션을 **CREATE 블록 이전**에 배치.
2. **`foreign_keys=ON` + `ADD COLUMN ... REFERENCES ... NOT NULL DEFAULT 1` 동시 불가**(SQLite 규칙: FK 활성 중 REFERENCES 컬럼 ADD는 기본값 NULL이어야 함). → ALTER 경로는 REFERENCES 생략, 신규 CREATE 경로만 REFERENCES 유지. **place_id FK divergence는 수용**(place_id 항상 1·place_info(1) 상존. 엄격 동치는 테이블 재빌드 12단계라 단순함 우선).
- `ALTER TABLE ... RENAME TO`가 **자식 slot_setup의 FK 참조를 자동 추종**함은 가정이 아니라 레거시 파일 DB를 시드해 **실증**함.

**검증**: tsc 0 / vitest **229파일 2685테스트 전량 green**. 신규 테스트 27건(`presetInfoMigration.test.ts` 4 + `presetInfoMigration.adversarial.test.ts` 23). 라이브(13020) `/db/tables`에 `preset_info` 노출·`preset_pos` 404, 5행 데이터 보존(updated_at이 마이그레이션 이전 시각 유지로 입증), slot_setup 23행 정합.

**핵심 사실 (다음 세션 참고)**

- ⚠️ **`sname`은 두 문맥에 공존**: (a) DB 컬럼/Row 필드 → `preset_name`/`presetName`으로 변경됨, (b) **camerapos.json의 JSON 키 `sname` → 외부 포맷 계약이라 불변**. `cameraposWriter`/`mapTargets`/`roiDbLoad`의 JSON 읽기·쓰기는 그대로고 **매핑 지점에서만 번역**한다. 일괄 sed 치환 금지.
- **`preset_pos` 잔존 참조는 전부 정당하니 지우지 말 것**: `SqliteStore.ts`(구DB 감지→rename하는 마이그레이션 로직 — 지우면 미변환 DB 영구 불가), `presetInfoMigration*.test.ts`·`slot3dFrontCenter.test.ts`(구 스키마를 **입력으로 시드**하는 픽스처), `SettingAgent/docs/*.md`(과거 시점 기록물).
- 실 DB는 서버 첫 기동 시 **자동 마이그레이션·롤백 코드 없음**. 백업 `data/setting.sqlite.bak-presetinfo-20260724_145745` + **`-wal`(3.1MB)·`-shm` 동반 필수**(본체 49KB보다 WAL이 큼 — WAL 빼면 복구 불가).
- 정본 문서 최종: `1 floor_ROI / 2 camera_info / 3 preset_info / 4 place_info / 5 slot_setup / 6 parking_evnt / 7 parking_slot` (번호 연속·중복 해소, preset_pos 완전 제거). 마스터가 직접 편집한 부분은 손대지 않고 그대로 커밋했다.

**⚠️ 동시 세션 충돌 (재발 방지)**

- 작업 중 **다른 세션이 같은 메인 리포에서 `cfc8d34`를 main에 올림**(Touring Test 버튼 이동 + result 버튼 제거). 그 커밋이 `test/setupResultRoute.test.ts`를 **내 커밋과 함께 건드려** FF 병합 불가 → **main 위로 rebase**로 해소(충돌 없이 자동병합됐지만 **자동병합은 문법만 보장**하므로 반드시 테스트로 재검증했고 전량 green).
- 그 과정에서 작업트리의 `web/app.js`·`index.html` 더티가 **남의 커밋 내용과 바이트 동일**함을 대조한 뒤에야 복원했다(남의 변경은 확인 없이 버리지 말 것).
- 무관 더티(마스터의 `my_db_table.md`, 런타임 `data/`, 기존 `_workspace_*` 삭제분 41건)는 **stash로 보호 후 전량 복원**, 커밋엔 1건도 안 섞였다. 커밋은 **경로 한정**(`git commit -- <paths>`)으로 인덱스에 이미 staged된 남의 삭제분을 피했다.
- 교훈: **병렬 세션이 예상되면 워크트리 분리가 안전**하다. 단 하네스 서브에이전트는 메인 리포에 launch-pin되므로, 이번엔 일부러 **메인 리포에 브랜치만 따서**(worktree 아님) 경로 불일치를 피했다 — 이 트레이드오프를 매번 판단할 것.

**잔여과제**

- ⚠️ **`preset_name`이 운영 DB 5행 전부 NULL** (선재 결함, 이번 회귀 아님 — updated_at이 마이그레이션보다 선행). 원인: `loadRoiIntoDb`가 camerapos 라벨을 upsert한 **직후** 라벨 없는 ROI 유래 프리셋을 재upsert해 `ON CONFLICT SET preset_name=excluded.preset_name`으로 **라벨을 말소**. 마스터 확인함·미수정.
- `preset_pos`/`preset_info` 동시 존재 시 구 테이블 데이터 **무경고 미이관**(F4, 현실성 낮아 수용).
- 마이그레이션된 기존 DB는 `place_id` 컬럼이 **맨 뒤**에 붙음(ADD COLUMN 특성, 기능 영향 없음).
- `feat/vpd-seg-cuboid` 원격 포인터가 4커밋 뒤처짐 — 내용은 origin/main에 있어 유실 없음(다른 세션 브랜치라 미조치).
- 관련 메모리: [[settingagent-db-schema]], [[finalize-slotsetup-wipe-fragility]], [[settingagent-persist-5decimals]].

**커밋**: `b04b3ff`(리네임 본체) → `d230870`(문서 preset_info 정의) → `58a60f8`(문서 preset_pos 제거) → `aa4d4a3`(문서 번호 재정렬). **main = origin/main = `aa4d4a3`**. 산출물: `SettingAgent/docs/20260724_152212_preset_pos를_preset_info로_리네임.md`, `SettingAgent/_workspace_preset_info/01~04`.

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
