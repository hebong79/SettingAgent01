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
