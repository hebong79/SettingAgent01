import { existsSync } from 'node:fs';

/**
 * 비밀값(.env) 로딩. config 파일에는 환경변수 "이름"만 두고 값은 여기서 process.env 로 올린다
 * (apiKeyEnv 규약과 동일한 분리).
 *
 * - 경로는 cwd 기준 `.env` — tools.config.json 로드 경로와 같은 기준이다. 인스턴스(13020/13021)는
 *   cwd 로 구분되므로(SettingAgent-13021/start.cmd) 비밀값도 인스턴스별 .env 를 따른다.
 * - 파일이 없으면 무동작(개발/CI 는 .env 없이 기동한다).
 * - Node `process.loadEnvFile` 은 **이미 설정된 실제 환경변수를 덮어쓰지 않는다**(셸·서비스 설정 우선).
 */
const ENV_FILE = '.env';

let loaded = false;

/** .env 를 1회만 로드한다. 실패해도 기동은 계속한다(비밀값 미해석은 소비 지점에서 드러난다). */
export function loadDotEnvOnce(): void {
  if (loaded) return;
  loaded = true;
  if (!existsSync(ENV_FILE)) return;
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    // 파싱 오류 등으로 서버 기동 자체를 막지 않는다.
  }
}
