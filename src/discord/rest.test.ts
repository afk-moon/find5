import { afterEach, describe, expect, it, vi } from "vitest";
import { appUrl, discordRedirectUri } from "./rest";

afterEach(() => vi.unstubAllEnvs());

const env = (APP_URL?: string, VERCEL_PROJECT_PRODUCTION_URL?: string) => {
  vi.stubEnv("APP_URL", APP_URL);
  vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", VERCEL_PROJECT_PRODUCTION_URL);
};

describe("appUrl", () => {
  it("tolerates a missing https://, a trailing slash, or a path in APP_URL", () => {
    for (const value of [
      "https://find5-peach.vercel.app",
      "find5-peach.vercel.app",
      "https://find5-peach.vercel.app/",
      " https://find5-peach.vercel.app/login ",
    ]) {
      env(value);
      expect(appUrl("https://some-deployment.vercel.app")).toBe("https://find5-peach.vercel.app");
    }
  });

  it("uses Vercel's production domain when APP_URL isn't set", () => {
    env(undefined, "find5-peach.vercel.app");
    expect(appUrl("https://find5-abc123-afk-moon.vercel.app")).toBe("https://find5-peach.vercel.app");
  });

  it("falls back to the current address locally", () => {
    env();
    expect(appUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(appUrl()).toBe("http://localhost:3000");
    env("localhost:3001");
    expect(appUrl()).toBe("http://localhost:3001");
  });

  it("keeps a typo visible rather than guessing (it's what Discord will be sent)", () => {
    env("find5-peach.vercep.app");
    expect(discordRedirectUri()).toBe("https://find5-peach.vercep.app/api/auth/discord/callback");
  });
});

describe("discordRedirectUri", () => {
  it("is the app address plus the callback path", () => {
    env("https://find5-peach.vercel.app/");
    expect(discordRedirectUri()).toBe("https://find5-peach.vercel.app/api/auth/discord/callback");
  });
});
