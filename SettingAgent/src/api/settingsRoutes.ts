import type { FastifyInstance } from 'fastify';
import {
  readEditableSettings,
  writeEditableSettings,
  SettingsPatchSchema,
  type SettingsPaths,
} from '../config/settingsStore.js';

/**
 * 웹 옵션 페이지 REST(설계서 §4). 기존 라우트 불변·가산.
 * - GET /settings  → 편집 대상 값(키 값 미노출) 반환.
 * - PUT /settings  → zod 검증 → 파일 부분 병합 → { ok, restartRequired:true }.
 * config 는 nodemon watch(src) 밖이라 저장해도 런타임 반영 안 됨 → restartRequired 로 재시작 필요를 명시.
 */
export function registerSettingsRoutes(app: FastifyInstance, paths: SettingsPaths): void {
  app.get('/settings', async () => readEditableSettings(paths));

  app.put('/settings', async (req, reply) => {
    const parsed = SettingsPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid body', detail: parsed.error.flatten() };
    }
    try {
      writeEditableSettings(parsed.data, paths);
      return { ok: true, restartRequired: true };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
