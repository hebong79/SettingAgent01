import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    /**
     * ★ 27-B — 검출 프레임 아카이브를 **테스트에서는 끈다**(기본은 ON).
     * 껐다가 알게 된 게 아니라 **켜 두고 실측해서** 안 사실이다: 도입 직후 첫 vitest 실행이
     * `reports/detect_frames/` 에 가짜 소스(`real-x`)의 픽스처 프레임 20쌍(4.3MB)을 흘렸다.
     * 아카이브는 "실제 관측"의 저장소이므로 모킹된 프레임이 섞이면 그 자체가 오염이다.
     * 아카이브 동작을 검증하는 테스트는 `ROI_FRAME_ARCHIVE_DIR` 을 임시 디렉터리로 두고 스스로 켠다.
     */
    env: { ROI_FRAME_ARCHIVE: '0' },
  },
});
