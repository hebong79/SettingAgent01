# 02p 구현 내역 — 카메라 평문 비밀번호의 환경변수 이전 (passwordEnv)

작성: 구현자(developer) / 대상: SettingAgent

## 1. 목적

`config/tools.config.json` 의 `cameraSources[real-camera-2].password` 에 있던 평문 비밀번호를
저장소에서 제거하고, 기존 `apiKeyEnv` 규약(**"환경변수 이름은 config, 값은 `process.env`"**)과 동일한
방식으로 `passwordEnv` 로 이전한다. 값은 git 무시 대상인 `.env` 에만 존재한다.

## 2. 변경 파일

| 파일 | 구분 | 내용 |
|------|------|------|
| `src/config/env.ts` | 신규 | `.env` 1회 로딩(`loadDotEnvOnce`). 파일이 없으면 무동작, 실패해도 기동 계속 |
| `src/config/toolsConfig.ts` | 수정 | `CameraSourceConfigSchema.passwordEnv` 추가 · `resolveCameraPassword()` 신규 · `resolveSecrets()` 를 `loadToolsConfig` 두 반환 경로에 적용 |
| `src/config/settingsStore.ts` | 수정 | `passwordSet` 계산을 `resolveCameraPassword` 기준으로(1줄). 값은 여전히 미노출 |
| `config/tools.config.json` | 수정 | `real-camera-2`: `password` 제거 → `"passwordEnv": "CAM_REAL2_PASSWORD"` |
| `.env` | 신규(git 무시) | `CAM_REAL2_PASSWORD=…` |
| `.env.example` | 신규(git 추적) | 키 이름만, 값은 빈칸 + 용도 주석 |
| `test/cameraPasswordEnv.test.ts` | 신규 | 우선순위 4케이스 + 로더 통합 + 역유출 회귀(총 11 테스트) |
| `../SettingAgent-13021/config/tools.config.json` | 수정 | 동일 처리(같은 평문이 있었음) |
| `../SettingAgent-13021/.env` | 신규(git 무시) | 인스턴스별 비밀값 |

## 3. 해석 지점을 `loadToolsConfig` 로 정한 근거

```
loadToolsConfig()  ──resolveSecrets()──▶  ToolsConfig
        │
        ├─ index.ts → buildSourceRegistry → RealPtzSource(cfg.password)
        ├─ index.ts → LensCalibrationJob(sources) → makeHucomsCameraPort(src.password)
        └─ mcp/server.ts, tools/*.ts
```

- 지시서가 지목한 소비 지점 3곳(`viewer/sourceRegistry.ts:30`, `calibrate/hucomsCameraPort.ts:57`,
  `viewer/RealPtzSource.ts:180`)은 **모두 `loadToolsConfig()` 산출물에서 내려온 `CameraSourceConfig`** 를 받는다
  (`cameraSources` 를 파일에서 직접 읽는 코드는 `settingsStore` 뿐 — 아래 참조). 로더에서 한 번 해석하면
  소비 지점은 **한 줄도 고치지 않고** 해석된 값을 받는다 → 규칙 중복 0.
- 반대로 설정 조회/저장(`settingsStore`)은 **raw 파일**을 읽어 화이트리스트 병합한다. 해석은 로더 쪽에만
  있으므로 해석값이 파일로 역유출될 경로가 구조적으로 없다(회귀 테스트로 못 박음).
- `.env` 로딩(`loadDotEnvOnce`)도 `resolveSecrets` 안에서 호출한다 — 모든 엔트리(`index.ts`·`mcp/server.ts`·
  `tools/*`)가 기동 직후 `loadToolsConfig()` 를 부르므로 "env 로드 → 해석" 순서가 항상 보장된다.
  엔트리마다 로딩 호출을 흩뿌리면 누락된 엔트리에서 조용히 미해석이 된다.

### 해석 규칙

```ts
resolveCameraPassword({ password, passwordEnv })
  = process.env[passwordEnv] (비어있지 않을 때)  ▶ 우선
  | password                                     ▶ 폴백(기존 평문, 하위호환)
  | undefined
```

## 4. `.env` 로딩 동작(확인 결과)

- 경로는 **cwd 기준 `.env`** — `tools.config.json` 기본 경로와 같은 기준이다.
  `SettingAgent-13021/start.cmd` 주석대로 **cwd 가 곧 인스턴스 지정**이며, `SettingAgent-13021/src` 는
  `SettingAgent/src` 심볼릭 링크라 모듈 위치 기준으로는 두 인스턴스가 구분되지 않는다.
- 파일이 없으면 `existsSync` 로 걸러 무동작, 있으면 `process.loadEnvFile()` 을 `try/catch` 로 감싼다.
- **덮어쓰기 여부(요청 확인 항목)**: Node 의 `loadEnvFile` 은 **이미 설정된 실제 환경변수를 덮어쓰지 않는다.**
  - 실측 1: `PRE_SET=from_shell node -e "process.loadEnvFile(t.env)"` → 파일의 `PRE_SET=from_file` 무시, 셸 값 유지.
  - 실측 2: 실제 `.env` 로 `CAM_REAL2_PASSWORD` 를 셸에서 먼저 설정 → 셸 값 유지(`true`).
  - 즉 운영에서 서비스/셸 환경변수를 주면 `.env` 보다 우선한다.

## 5. 검증 결과

| 항목 | 결과 |
|------|------|
| `npx tsc -p tsconfig.json --noEmit` | exit 0 |
| `npx vitest run` (전량) | **282 파일 / 3564 테스트 전량 green** (기준선 281/3553 + 신규 1파일/11테스트) |
| 신규 유닛테스트 | ①env 우선 ②env 미설정→평문 폴백 ③둘 다 없음→undefined ④env 빈 문자열→폴백 ⑤env 지정+평문 없음→undefined |
| 로더 통합 | `cameraSources`·`realCamera` 양쪽 해석, `passwordEnv` 이름은 보존 |
| **역유출 회귀** | `writeEditableSettings` 로 label 저장 후 파일에 해석값·`"password"` 키 모두 부재, `passwordEnv` 보존 |
| 실제 해석(13020) | `real-camera-2` → `passwordEnv=CAM_REAL2_PASSWORD`, `resolvedLen=10`, `.env` 값과 일치 `true` |
| 실제 해석(13021) | 동일하게 일치 `true` |
| `.env` git 무시 | `git check-ignore -v SettingAgent/.env` → `.gitignore:38:.env` 매치, `git status --porcelain` 출력 없음 = 무시됨 |
| `.env.example` | `!.env.example` 규칙으로 **추적 대상**(`??` = untracked, ignored 아님) |
| 임시 검증 스크립트 | 실행 후 삭제 확인 |

콘솔·본 문서 어디에도 비밀번호 값을 출력/기재하지 않았다(길이·일치 boolean 만 사용).

## 6. 영향도 분석

- **소비 지점 3곳 코드 무변경.** 해석된 `password` 를 받으므로 동작 동일.
- **하위호환**: `passwordEnv` 없는 기존 소스(`simulator-1`, `real-camera-1`)는 평문 `password` 를 그대로 사용.
  스키마는 `optional` 추가라 기존 config 파싱에 영향 없음.
- **웹 옵션창**: `GET /settings` 의 `passwordSet` 이 `passwordEnv` 해석 결과도 반영하도록 1줄 수정했다.
  이 한 줄이 없으면 이전한 `real-camera-2` 가 UI 에 "저장된 비밀번호 없음"으로 잘못 표시된다.
  값 자체는 여전히 노출하지 않는다(테스트로 확인).
- **범위 밖 무접촉 확인**: `src/ground/*`, `src/rpc/services/roiAuto.ts`, `data/Place01/PtzCamRoi.json`, DB 미변경.
  서버 재시작·프로세스 종료 없음.

## 7. 남은 위험 · 마스터 결정 필요 (중요)

1. **평문이 이미 git 이력에 있다.** 본 작업 대상 `config/tools.config.json` 은 **이력에 없었지만**
   (`git log -S` 0건, HEAD 에 해당 필드 없음), 아래 **추적 문서 3파일 4곳**에 같은 평문이 커밋되어 있다
   (관련 커밋 3개). 파일 목록:
   - `SettingAgent/docs/20260725_123605_광각렌즈_곡면율_캘리브레이션_구현.md:155`
   - `SettingAgent/docs/20260728_204710_승인프롬프트_자동승인_체계.md:91`
   - `메모/memo.md:638, 646`

   이 파일들은 본 작업 범위 밖이고 `메모/memo.md` 는 마스터 정본이라 **임의로 수정하지 않았다.**
   작업 트리만 지워도 이력에는 남으므로, 실질적 해법은 **카메라 비밀번호 교체(rotate)** 다.
2. **웹 옵션창에서 `real-camera-2` 비밀번호를 바꿔도 무효**다 — 파일에 평문이 새로 기록되더라도
   해석은 `passwordEnv` 가 우선한다. 앞으로 이 카메라의 비밀번호 변경은 `.env` 에서 한다.
3. 배포 시 `.env` 는 git 으로 전달되지 않는다 — 새 환경에는 `.env.example` 을 복사해 값을 채워야 한다.
