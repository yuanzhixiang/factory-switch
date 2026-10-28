// 移植自 T3 Code（MIT）apps/server/src/usage/UsageService.test.ts 中与本批提供方相关的用例，
// Effect 的 Layer/Fiber 改成普通 Promise，断言保持不变。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { encodeScanCache, SCAN_CACHE_FILE_NAME } from "../../src/core/token-usage/scan-cache";
import { createUsageService } from "../../src/core/token-usage/service";
import { createTokenUsageSettingsStore } from "../../src/core/token-usage/settings";
import { totalTokens } from "../../src/core/token-usage/types";
import type { UsageSummary, UsageSummaryInput } from "../../src/shared/token-usage";

function claudeLine(id: number, outputTokens: number, model = "claude-fable-5"): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-01T10:00:00Z",
    requestId: `req_${id}`,
    sessionId: "session-1",
    message: {
      id: `msg_${id}`,
      model,
      usage: { input_tokens: 10, output_tokens: outputTokens },
    },
  })}\n`;
}

const WINDOW: UsageSummaryInput = {
  timeZone: "UTC",
  sinceDay: "2026-07-31",
  untilDay: "2026-08-02",
};

function totalOutputTokens(summary: { buckets: readonly { totals: { outputTokens: number } }[] }) {
  return summary.buckets.reduce((sum, bucket) => sum + bucket.totals.outputTokens, 0);
}

const homes: string[] = [];
const services: { awaitPersisted(): Promise<void> }[] = [];

// 和 T3 的 scope 收尾一样，先等后台写缓存完成再删临时目录
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.awaitPersisted()));
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

async function setup() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "usage-service-test-"));
  homes.push(home);
  const transcriptDir = path.join(home, "claude", "projects", "proj");
  await fs.mkdir(transcriptDir, { recursive: true });
  return { home, transcript: path.join(transcriptDir, "session.jsonl") };
}

interface ServiceOptions {
  readonly prefix: string;
  readonly home: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly ratesDocument?: unknown;
  readonly httpFetch?: typeof fetch;
}

/** 对应 T3 的 layerService：各家主目录都指向临时目录，价格接口用假数据 */
function makeService(options: ServiceOptions) {
  const stateDir = path.join(options.home, options.prefix);
  const settings = createTokenUsageSettingsStore(stateDir);
  const service = createUsageService({
    stateDir,
    readerEnv: {
      homeDir: options.home,
      environment: {
        HOME: options.home,
        CLAUDE_CONFIG_DIR: path.join(options.home, "claude"),
        CODEX_HOME: path.join(options.home, "codex"),
        GROK_HOME: path.join(options.home, "grok"),
        PI_CODING_AGENT_DIR: path.join(options.home, "pi"),
        ...options.environment,
      },
    },
    readSettings: settings.read,
    httpFetch:
      options.httpFetch ??
      (async () => Response.json(options.ratesDocument ?? {}, { status: 200 })),
  });
  services.push(service);
  return { service, settings, stateDir };
}

function source(summary: UsageSummary, provider: string) {
  return summary.sources.find((entry) => entry.fingerprint.provider === provider);
}

describe("UsageService", () => {
  it("reports missing Pi history and skips malformed records without losing valid usage", async () => {
    const { home } = await setup();
    const { service } = makeService({ prefix: "usage-pi-malformed", home });
    const missing = await service.readSummary(WINDOW);
    expect(source(missing, "pi")?.status).toBe("missing");
    const dir = path.join(home, "pi", "sessions");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "session.jsonl"),
      [
        "{broken",
        "null",
        JSON.stringify({ type: "session", id: "valid" }),
        JSON.stringify({
          type: "message",
          id: "bad",
          timestamp: "invalid",
          message: {
            role: "assistant",
            provider: "openai",
            model: "model",
            usage: { input: 100 },
          },
        }),
        JSON.stringify({
          type: "message",
          id: "valid",
          timestamp: "2026-08-01T10:00:00Z",
          message: {
            role: "assistant",
            provider: "openai",
            model: "model",
            usage: {
              input: -1,
              cacheRead: "100",
              output: 7,
              reasoning: 50,
              cost: { total: -1 },
            },
          },
        }),
      ].join("\n") + "\n",
    );
    const summary = await service.readSummary(WINDOW);
    const pi = summary.buckets.filter((bucket) => bucket.provider === "pi");
    expect(pi.length).toBe(1);
    expect(pi[0] && totalTokens(pi[0].totals)).toBe(7);
    expect(pi[0]?.totals.reasoningTokens).toBe(7);
    expect(pi[0]?.costSource).toBe("unpriced");
  });

  it("discovers Pi history in its default home and directory overrides", async () => {
    const { home } = await setup();
    for (const [agentDir, sessionDir, relativeDir] of [
      [undefined, undefined, ".pi/agent/sessions"],
      ["~/custom-pi", undefined, "custom-pi/sessions"],
      ["~/ignored-pi", "~/custom-sessions", "custom-sessions"],
      ["~/ignored-pi", path.join(home, "absolute-sessions"), "absolute-sessions"],
    ] as const) {
      const dir = path.join(home, relativeDir);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "session.jsonl"),
        [
          { type: "session", id: relativeDir },
          {
            type: "usage",
            id: "warm",
            timestamp: "2026-08-01T10:00:00Z",
            provider: "openai",
            model: "model",
            usage: { input: 7 },
          },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n") + "\n",
      );
      const { service } = makeService({
        prefix: "usage-pi-" + relativeDir.replaceAll("/", "-"),
        home,
        environment: {
          PI_CODING_AGENT_DIR: agentDir,
          PI_CODING_AGENT_SESSION_DIR: sessionDir,
        },
      });
      const summary = await service.readSummary(WINDOW);
      const pi = summary.buckets.filter((bucket) => bucket.provider === "pi");
      expect(pi.length).toBe(1);
      expect(pi[0]?.totals.uncachedInputTokens).toBe(7);
      expect(source(summary, "pi")?.fingerprint.resolvedHomePath).toBe(await fs.realpath(dir));
    }
  });

  it("reprices unchanged transcripts when custom prices are added, edited, or removed", async () => {
    const { transcript, home } = await setup();
    await fs.writeFile(transcript, claudeLine(1, 5, "example-model"));
    const { service, settings } = makeService({
      prefix: "usage-service-price-overrides-test",
      home,
    });

    const original = await service.readSummary(WINDOW);
    expect(original.buckets[0]?.costUsd).toBe(0);
    expect(original.buckets[0]?.unpricedRecords).toBe(1);

    await settings.update({
      usagePriceOverrides: {
        "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
      },
    });
    const overridden = await service.readSummary(WINDOW);
    expect(overridden.buckets[0]?.costUsd).toBeCloseTo(0.00006, 12);
    expect(overridden.buckets[0]?.costSource).toBe("modelPriced");
    expect(overridden.buckets[0]?.unpricedRecords).toBe(0);
    expect(overridden.buckets[0]?.totals).toEqual(original.buckets[0]?.totals);

    await settings.update({
      usagePriceOverrides: {
        "example-model": { inputCostPerMillionTokens: 4, outputCostPerMillionTokens: 16 },
      },
    });
    const edited = await service.readSummary(WINDOW);
    expect(edited.buckets[0]?.costUsd).toBeCloseTo(0.00012, 12);

    await settings.update({ usagePriceOverrides: { "example-model": null } });
    const restored = await service.readSummary(WINDOW);
    expect(restored.buckets).toEqual(original.buckets);
  });

  it("preserves saved tokens, costs and sessions after transcript cleanup and restart", async () => {
    const { transcript, home } = await setup();
    const alias = path.join(home, "claude-alias");
    await fs.symlink(path.join(home, "claude"), alias, "junction");
    const content = claudeLine(1, 5);
    await fs.writeFile(transcript, content);
    const options: ServiceOptions = {
      prefix: "usage-service-cleanup-test",
      home,
      environment: { CLAUDE_CONFIG_DIR: alias },
      ratesDocument: {
        "claude-fable-5": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
      },
    };
    const { service } = makeService(options);
    const first = await service.readSummary(WINDOW);
    expect(totalOutputTokens(first)).toBe(5);
    expect(first.buckets[0]?.costUsd ?? 0).toBeGreaterThan(0);

    await fs.rm(transcript);
    const deleted = await service.readSummary(WINDOW);
    expect(deleted.buckets).toEqual(first.buckets);
    expect(deleted.sources).toEqual(first.sources);

    await service.awaitPersisted();
    const restarted = makeService(options).service;
    const restored = await restarted.readSummary(WINDOW);
    expect(restored.buckets).toEqual(first.buckets);
    expect(restored.sources).toEqual(first.sources);

    await fs.writeFile(transcript + ".jsonl", content);
    const moved = await restarted.readSummary(WINDOW);
    expect(moved.buckets).toEqual(first.buckets);
    expect(source(moved, "claude")?.distinctSessions).toBe(1);
    await restarted.awaitPersisted();

    const replacementProjects = path.join(home, "replacement-projects");
    await fs.mkdir(replacementProjects);
    await fs.rm(path.join(home, "claude", "projects"), { recursive: true });
    const afterRootCleanup = makeService(options).service;
    const missingRoot = await afterRootCleanup.readSummary(WINDOW);
    expect(missingRoot.buckets).toEqual(first.buckets);
    expect(source(missingRoot, "claude")?.distinctSessions).toBe(1);
    expect(source(missingRoot, "claude")?.status).toBe("ok");
    expect(source(missingRoot, "claude")?.fingerprint).toEqual(source(first, "claude")?.fingerprint);
    const projects = path.join(home, "claude", "projects");
    await fs.rename(replacementProjects, projects);
    await fs.writeFile(path.join(projects, "new.jsonl"), claudeLine(2, 7));
    const recreated = await afterRootCleanup.readSummary(WINDOW);
    expect(totalOutputTokens(recreated)).toBe(12);
    expect(source(recreated, "claude")?.fingerprint).toEqual(source(first, "claude")?.fingerprint);

    const outsideWindow = await restarted.readSummary({ ...WINDOW, sinceDay: "2026-08-02" });
    expect(outsideWindow.buckets).toEqual([]);
    expect(source(outsideWindow, "claude")?.distinctSessions).toBe(0);
  });

  it("credits the same copy of a duplicate after its transcripts are deleted", async () => {
    const { transcript, home } = await setup();
    const dir = path.dirname(transcript);
    await fs.writeFile(path.join(dir, "a.jsonl"), "");
    await fs.writeFile(path.join(dir, "b.jsonl"), "");
    const [first = "", second = ""] = (await fs.readdir(dir)).map((name) => path.join(dir, name));
    const forked = (line: string) => line.replace('"session-1"', '"session-2"');
    await fs.writeFile(
      first,
      claudeLine(1, 5).replace(
        '"message":',
        '"padding":' + JSON.stringify("x".repeat(9 * 1024 * 1024)) + ',"message":',
      ),
    );
    await fs.writeFile(second, forked(claudeLine(1, 5)) + forked(claudeLine(2, 7)));
    const options = { prefix: "usage-service-copy-order-test", home };
    const { service } = makeService(options);
    const live = await service.readSummary(WINDOW);
    expect(live.buckets[0]?.sessions).toBe(2);

    await Promise.all([fs.rm(first), fs.rm(second)]);
    const saved = await service.readSummary(WINDOW);
    expect(saved.buckets).toEqual(live.buckets);
    expect(saved.sources).toEqual(live.sources);
    await service.awaitPersisted();
    const restored = await makeService(options).service.readSummary(WINDOW);
    expect(restored.buckets).toEqual(live.buckets);
  });

  it("keeps an absent directory missing when its cached files only contain diagnostics", async () => {
    const { transcript, home } = await setup();
    await fs.rm(path.join(home, "claude", "projects"), { recursive: true });
    const { service, stateDir } = makeService({
      prefix: "usage-service-missing-diagnostics",
      home,
    });
    const cache = encodeScanCache(
      new Map([
        [
          transcript,
          {
            size: 0,
            mtimeMs: Date.now(),
            provider: "claude" as const,
            records: [],
            tailRecords: [],
            malformedRecords: 2,
            position: { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null },
          },
        ],
      ]),
    );
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, SCAN_CACHE_FILE_NAME), JSON.stringify(cache));
    const summary = await service.readSummary(WINDOW);
    const claude = source(summary, "claude");
    expect(claude?.status).toBe("missing");
    expect(claude?.scannedFiles).toBe(0);
    expect(claude?.malformedRecords).toBe(2);
  });

  it("reports saved usage of a removed directory only for windows it reaches", async () => {
    const { transcript, home } = await setup();
    await fs.writeFile(transcript, claudeLine(1, 5));
    const lastWrite = Date.parse("2026-08-01T10:00:00Z") / 1000;
    await fs.utimes(transcript, lastWrite, lastWrite);
    const { service } = makeService({ prefix: "usage-service-saved-window-test", home });
    const first = await service.readSummary(WINDOW);
    await fs.rm(path.join(home, "claude", "projects"), { recursive: true });

    const reached = await service.readSummary(WINDOW);
    expect(reached.buckets).toEqual(first.buckets);
    expect(source(reached, "claude")?.status).toBe("ok");

    const later = await service.readSummary({
      timeZone: "UTC",
      sinceDay: "2026-08-10",
      untilDay: "2026-08-12",
    });
    expect(later.buckets).toEqual([]);
    expect(source(later, "claude")?.status).toBe("missing");
    expect(source(later, "claude")?.scannedFiles).toBe(0);
  });

  it("does not share an in-flight scan after custom prices change", async () => {
    const { transcript, home } = await setup();
    await fs.writeFile(transcript, claudeLine(1, 5, "example-model"));
    let releaseRates!: () => void;
    const ratesReleased = new Promise<void>((resolve) => {
      releaseRates = resolve;
    });
    let fetchStarted!: () => void;
    const firstFetch = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    const { service, settings } = makeService({
      prefix: "usage-service-price-race-test",
      home,
      httpFetch: async () => {
        fetchStarted();
        await ratesReleased;
        return Response.json({});
      },
    });

    const first = service.readSummary(WINDOW);
    // 第一次扫描已读完设置、正在等价格表
    await firstFetch;
    await settings.update({
      usagePriceOverrides: {
        "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
      },
    });
    const second = service.readSummary(WINDOW);
    releaseRates();

    const original = await first;
    const updated = await second;
    expect(original.buckets[0]?.costUsd).toBe(0);
    expect(updated.buckets[0]?.costUsd).toBeCloseTo(0.00006, 12);
  });

  it.each(["network", "http", "invalidJson", "empty"] as const)(
    "recovers pricing through the GitHub API after a %s failure",
    async (failure) => {
      const { transcript, home } = await setup();
      await fs.writeFile(transcript, claudeLine(1, 5));
      const requests: { url: string; accept: string | null }[] = [];
      const ratesDocument = {
        "claude-fable-5": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
      };
      const httpFetch: typeof fetch = async (input, init) => {
        const url = String(input);
        requests.push({ url, accept: new Headers(init?.headers).get("accept") });
        if (url.startsWith("https://api.github.com/")) return Response.json(ratesDocument);
        if (failure === "network") {
          throw new TypeError("getaddrinfo ENOTFOUND raw.githubusercontent.com");
        }
        return failure === "invalidJson"
          ? new Response("not JSON")
          : Response.json({}, { status: failure === "http" ? 503 : 200 });
      };
      const options = { prefix: `usage-service-rates-fallback-${failure}-test`, home, httpFetch };
      const { service } = makeService(options);

      const summary = await service.readSummary(WINDOW);
      expect(summary.pricing.status).toBe("fresh");
      expect(summary.pricing.knownModels).toBe(1);
      expect(summary.buckets[0]?.costUsd).toBeCloseTo(0.00035, 12);
      expect(requests.map((request) => request.url)).toEqual([
        "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
        "https://api.github.com/repos/BerriAI/litellm/contents/model_prices_and_context_window.json?ref=main",
      ]);
      expect(requests[1]?.accept).toBe("application/vnd.github.raw+json");

      const restarted = makeService(options).service;
      const cached = await restarted.readSummary(WINDOW);
      expect(cached.pricing.status).toBe("cached");
      expect(cached.buckets).toEqual(summary.buckets);
      expect(requests.length).toBe(2);
    },
  );
});
