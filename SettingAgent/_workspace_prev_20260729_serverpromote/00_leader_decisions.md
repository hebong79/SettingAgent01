# 00 리더 판단 — 설계서(01) 열린 질문 확정

설계자가 제기한 Q1~Q4 및 전제 반증 3건에 대한 확정 결정. 구현자·검증자는 **이 파일이 설계서보다 우선**한다.

## 전제 반증 3건 — 전부 수용

| # | 설계자 발견 | 결정 |
|---|---|---|
| 1 | `buildTouringPlan` 은 서버에 없다(`web/core.js:1689` 전용) | 수용. 투어링은 **순수함수 포팅 + 파리티**를 포함한다 |
| 2 | 슬롯편집은 `save/Setup_*.json`·DB 가 아니라 `data/setup_artifact.json` 만 건드린다. 진짜 위험은 `POST /mapping/renumber` 가 artifact 를 DB 기준으로 덮어써 추가분이 소실되는 **순서 문제** | 수용. 코드로 막지 말고 `warnings[]` + 카탈로그 `note` 로 알린다(설계 R10 그대로) |
| 3 | 사전 실패는 2건이 아니라 **3건** — `test/buildTouringPlan.test.ts` 가 `.gitignore` 된 `save/setup_result.json` 을 읽어 ENOENT | 수용. **fixture 이관을 1단계로 수행**한다. 런타임 산출물은 테스트 고정입력이 될 수 없다 |

## Q1 — `plate.detect` 토큰 게이트 면제 여부

**결정: (a) 현행 유지(면제).**
카탈로그의 `mutating` 계약을 바꾸는 것은 이번 범위를 넘고 `rpcDispatch.test.ts` 의 의미를 흔든다. 다만 "읽기 선언인데 카메라를 물리 이동시킨다"는 **모순은 실재**하므로, 문서화 단계에서 **알려진 한계로 명시**하고 memo 후속 후보에 올린다. 은닉 금지.

## Q2 — `GROUND_BAND_RATIO` 등 상수 위치

**결정: (a) `src/domain/occupancyJudge.ts` 가 `src/capture/onPlaceFilter.ts` 에서 import.**
외과적 변경 원칙. 값 복제는 절대 금지(파리티가 못 잡는 3번째 정의가 생긴다). 순환 없음은 구현자가 재확인할 것.

## Q3 — 슬롯편집 UX ★설계안 수정

**결정: (a)도 (b)도 아닌 — 라우트가 `dryRun` 을 지원하되 기본은 커밋.**

- `POST /mapping/slot/add`·`/delete` 본문에 옵셔널 `artifact`(호출자 버퍼) + 옵셔널 `dryRun`(기본 `false`).
- `artifact` 미제공 → 서버가 `data/setup_artifact.json` 을 읽는다. `dryRun:false` → 편집 후 저장(외부 RPC 호출자는 **한 방에 커밋**).
- 웹은 `artifact: <현재 버퍼>, dryRun: true` 로 호출 → 편집된 artifact 만 돌려받고 **기존 "추가 → Ctrl+드래그 배치 → 저장" 2단계 UX 를 그대로 유지**한다.

**근거**: 마스터 요구는 ⓐ 서버 정본화 ⓑ 웹 껍데기화 ⓒ **기존 UX 유지** 셋 다이다. (a)단독은 ⓒ 위반(배치 전 임시 rect 가 파일에 남고, 추가 후 취소하면 쓰레기 슬롯이 남는다), (b)단독은 ⓐ 반쪽. `dryRun` 파라미터화는 **웹에서 편집 로직을 완전히 제거**하면서(껍데기 달성) UX 를 보존한다. 서버는 두 경우 모두 같은 `artifactSlotEdit` 순수함수를 쓰므로 정본은 하나다.

`dryRun:true` 는 **파일을 절대 쓰지 않는다** — 테스트에서 md5 불변으로 봉인할 것.

## Q4 — `setup.slot.add` 의 의미

**결정: (a) artifact 편집 승격.**
(b) 복합 메서드는 "RPC 는 로직을 갖지 않는다" 원칙과 충돌한다. 다만 **이름이 오해를 부른다** — 카탈로그 `note` 와 문서에 *"주차면(공간) 추가는 `place.space.add`+`slot.roi.sync`. 이 메서드는 setup artifact 의 슬롯 엔트리 편집이다"* 를 반드시 명시한다.

## 진행 방식

설계서 §5 의 13단계를 **4개 웨이브로 나눠 순차 실행**한다(마스터 요청 순서 = 토큰 → 투어링 → 점유판정 → 슬롯편집). 웨이브마다 `npx tsc --noEmit` 0 + 관련 vitest green 을 확인한 뒤 다음으로 넘어간다.

| 웨이브 | 단계 | 비고 |
|---|---|---|
| W1 | 1(fixture) + 2(게이트 서버) + 3(토큰 웹) | R1 때문에 2·3 은 **반드시 한 웨이브** |
| W2 | 4·5·6 투어링 | |
| W3 | 7·8·9 점유판정 | |
| W4 | 10·11·12 슬롯편집 (Q3 결정 반영) | |
| 마감 | 13 | 카탈로그 76 확인 + 전체 vitest |
