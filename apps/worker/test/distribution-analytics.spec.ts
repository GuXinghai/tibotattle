import { describe, expect, it, vi } from "vitest";

import { readDistributionAnalytics } from "../src/distribution-analytics";

const NOW = Date.parse("2026-08-17T12:00:00.000Z");
const ANALYTICS_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const GITHUB_ENDPOINT =
  "https://api.github.com/repos/adamallcock/tibotattle/releases?per_page=100&page=1";
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

function analyticsRow({
  count = 1,
  sampleInterval = 1,
  clientIP,
  userAgent,
  edgeResponseStatus = 200,
}: {
  count?: number;
  sampleInterval?: number;
  clientIP: string;
  userAgent: string;
  edgeResponseStatus?: number;
}): object {
  return {
    count,
    avg: { sampleInterval },
    dimensions: { clientIP, userAgent, edgeResponseStatus },
  };
}

function zoneResponse(rows: readonly object[]): Response {
  return jsonResponse({
    data: { viewer: { zones: [{ electronWindowsX64: rows }] } },
    errors: null,
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pagedJsonResponse(
  value: unknown,
  link: string | null,
): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...(link === null ? {} : { link }),
    },
  });
}

function githubRelease(): object[] {
  return [{
    id: 12,
    tag_name: "v0.1.12",
    published_at: "2026-08-15T18:00:00.000Z",
    draft: false,
    prerelease: false,
    assets: [
      { id: 1201, name: "TiboTattle-0.1.12.dmg", download_count: 88 },
      { id: 1202, name: "SHA256SUMS.txt", download_count: 13 },
    ],
  }];
}

function segmentStart(index: number): string {
  return new Date(NOW - 7 * DAY_MILLISECONDS + index * DAY_MILLISECONDS).toISOString();
}

describe("owner distribution analytics", () => {
  it("aggregates Windows update checks without returning source addresses or user agents", async () => {
    const segmentStarts: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === GITHUB_ENDPOINT) return jsonResponse(githubRelease());
      expect(url).toBe(ANALYTICS_ENDPOINT);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer analytics-secret",
      );
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { start: string; end: string };
      };
      // Only the Windows update feed is queried; retired feeds are absent.
      expect(body.query).toContain("/electron/stable/win32-x64/latest.yml");
      for (const retired of ["/appcast.xml", "/intel/", "darwin", "linux-x64", "releases/%"]) {
        expect(body.query).not.toContain(retired);
      }
      const { start, end } = body.variables;
      segmentStarts.push(start);
      expect(Date.parse(end) - Date.parse(start)).toBe(DAY_MILLISECONDS);
      if (start === segmentStart(0)) {
        return zoneResponse([
          analyticsRow({
            count: 2,
            sampleInterval: 2,
            clientIP: "203.0.113.1",
            userAgent: "TiboTattle/0.1.12 electron-updater",
          }),
          analyticsRow({
            clientIP: "203.0.113.5",
            userAgent: "TiboTattle/0.1.12 electron-updater",
          }),
        ]);
      }
      if (start === segmentStart(6)) {
        return zoneResponse([
          analyticsRow({
            count: 3,
            clientIP: "203.0.113.2",
            userAgent: "TiboTattle/0.1.12 electron-updater",
            edgeResponseStatus: 304,
          }),
          analyticsRow({
            count: 2,
            clientIP: "203.0.113.4",
            userAgent: "TiboTattle/0.1.11 electron-updater",
          }),
          // Not a TiboTattle or Electron updater client: never counted.
          analyticsRow({
            count: 999,
            clientIP: "203.0.113.99",
            userAgent: "Mozilla/5.0",
          }),
          // A failed check is not an observed update check.
          analyticsRow({
            count: 5,
            clientIP: "203.0.113.3",
            userAgent: "TiboTattle/0.1.12 electron-updater",
            edgeResponseStatus: 500,
          }),
        ]);
      }
      return zoneResponse([]);
    }) as unknown as typeof fetch;
    const overview = await readDistributionAnalytics({
      enabled: true,
      cloudflareZoneId: "zone-id",
      cloudflareApiToken: "analytics-secret",
    }, NOW, fetcher);
    expect([...segmentStarts].sort()).toEqual(
      Array.from({ length: 7 }, (_, index) => segmentStart(index)).sort(),
    );
    expect(fetcher).toHaveBeenCalledTimes(8);
    expect(overview.cloudflare).toMatchObject({
      status: "available",
      sampled: true,
      bounded: false,
      activeSourceAddresses: { last24Hours: 2, last7Days: 4 },
      electronChecks: {
        requests: { last24Hours: 5, last7Days: 8 },
        sourceAddresses: { last24Hours: 2, last7Days: 4 },
      },
      currentVersion: "0.1.12",
      currentVersionSourceAddresses: { last24Hours: 1, last7Days: 3 },
      observedVersions: [{
        client: "electron",
        operatingSystem: "windows",
        architecture: "x64",
        version: "0.1.12",
        requestsLast7Days: 6,
        sourceAddressesLast7Days: 3,
      }, {
        client: "electron",
        operatingSystem: "windows",
        architecture: "x64",
        version: "0.1.11",
        requestsLast7Days: 2,
        sourceAddressesLast7Days: 1,
      }],
      observedVersionsBounded: false,
      observedTotals: {
        platforms: [{
          operatingSystem: "windows",
          requestsLast7Days: 8,
          sourceAddressesLast7Days: 4,
        }],
        overall: {
          requestsLast7Days: 8,
          sourceAddressesLast7Days: 4,
        },
      },
    });
    expect(overview.cloudflare.bySegment).toHaveLength(7);
    expect(overview.cloudflare.bySegment.slice(0, 2)).toEqual([{
      startsAt: segmentStart(0),
      endsAt: segmentStart(1),
      activeSourceAddresses: 2,
      electronCheckRequests: 3,
      currentVersionSourceAddresses: 2,
    }, {
      startsAt: segmentStart(1),
      endsAt: segmentStart(2),
      activeSourceAddresses: 0,
      electronCheckRequests: 0,
      currentVersionSourceAddresses: 0,
    }]);
    expect(overview.cloudflare.bySegment.at(-1)).toEqual({
      startsAt: segmentStart(6),
      endsAt: "2026-08-17T12:00:00.000Z",
      activeSourceAddresses: 2,
      electronCheckRequests: 5,
      currentVersionSourceAddresses: 1,
    });
    expect(overview.github).toMatchObject({
      status: "available",
      repository: "adamallcock/tibotattle",
      release: {
        tag: "v0.1.12",
        dmgDownloads: 88,
        allAssetDownloads: 101,
      },
      summary: {
        dmgDownloads: 88,
        allAssetDownloads: 101,
        dmgAssetCount: 1,
        assetCount: 2,
        releaseCount: 1,
      },
      releases: [{
        id: 12,
        tag: "v0.1.12",
        prerelease: false,
        dmgDownloads: 88,
      }],
    });
    const serialized = JSON.stringify(overview);
    expect(serialized).not.toContain("203.0.113");
    expect(serialized).not.toContain("electron-updater");
    expect(serialized).not.toContain("analytics-secret");
  });

  it("deduplicates observed totals across versions and segments before the version cap", async () => {
    const rowsBySegment = new Map<string, object[]>(
      Array.from({ length: 7 }, (_, index) => [segmentStart(index), []]),
    );
    rowsBySegment.get(segmentStart(0))?.push(
      analyticsRow({ count: 2, clientIP: "198.51.100.1", userAgent: "TiboTattle/1.0.0 electron-updater" }),
      analyticsRow({ count: 5, clientIP: "198.51.100.1", userAgent: "TiboTattle/3.0.0 electron-updater" }),
    );
    rowsBySegment.get(segmentStart(3))?.push(
      analyticsRow({ count: 4, clientIP: "198.51.100.1", userAgent: "TiboTattle/2.0.0 electron-updater" }),
    );
    rowsBySegment.get(segmentStart(6))?.push(
      ...Array.from({ length: 30 }, (_, index) => analyticsRow({
        clientIP: `198.51.100.${index + 2}`,
        userAgent: `TiboTattle/9.${index}.0 electron-updater`,
      })),
    );
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === GITHUB_ENDPOINT) return jsonResponse(githubRelease());
      expect(url).toBe(ANALYTICS_ENDPOINT);
      const body = JSON.parse(String(init?.body)) as {
        variables: { start: string };
      };
      const rows = rowsBySegment.get(body.variables.start);
      if (rows === undefined) throw new Error("unexpected analytics segment");
      return zoneResponse(rows);
    }) as unknown as typeof fetch;
    const overview = await readDistributionAnalytics({
      enabled: true,
      cloudflareZoneId: "zone-id",
      cloudflareApiToken: "analytics-secret",
    }, NOW, fetcher);
    expect(overview.cloudflare).toMatchObject({
      status: "available",
      observedVersionsBounded: true,
      observedTotals: {
        platforms: [{
          operatingSystem: "windows",
          requestsLast7Days: 41,
          sourceAddressesLast7Days: 31,
        }],
        overall: {
          requestsLast7Days: 41,
          sourceAddressesLast7Days: 31,
        },
      },
    });
    expect(overview.cloudflare.observedVersions).toHaveLength(24);
    expect(overview.cloudflare.observedVersions.slice(0, 3).map((row) => row.version))
      .toEqual(["3.0.0", "2.0.0", "1.0.0"]);
  });

  it("does no external work when distribution evidence is disabled", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const overview = await readDistributionAnalytics(
      { enabled: false },
      NOW,
      fetcher,
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(overview.cloudflare).toMatchObject({
      status: "not_configured",
      reasonCode: "DISTRIBUTION_DISABLED",
      observedTotals: null,
    });
    expect(overview.github.status).toBe("not_configured");
  });

  it("keeps GitHub evidence when Cloudflare analytics is not configured", async () => {
    const fetcher = vi.fn(async () => jsonResponse(githubRelease())) as unknown as typeof fetch;
    const overview = await readDistributionAnalytics(
      { enabled: true, cloudflareZoneId: "zone-id" },
      NOW,
      fetcher,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(overview.cloudflare).toMatchObject({
      status: "not_configured",
      reasonCode: "ANALYTICS_NOT_CONFIGURED",
    });
    expect(overview.github.status).toBe("available");
  });

  it("follows GitHub pagination, excludes drafts, and keeps prereleases distinct", async () => {
    const pageTwo =
      "https://api.github.com/repos/adamallcock/tibotattle/releases?per_page=100&page=2";
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === GITHUB_ENDPOINT) {
        return pagedJsonResponse([
          {
            id: 99,
            tag_name: "draft",
            published_at: "2026-08-17T00:00:00.000Z",
            draft: true,
            prerelease: false,
            assets: [],
          },
          {
            id: 12,
            tag_name: "v0.1.12",
            published_at: "2026-08-15T18:00:00.000Z",
            draft: false,
            prerelease: false,
            assets: [{ id: 1201, name: "TiboTattle-0.1.12.dmg", download_count: 88 }],
          },
        ], `<${pageTwo}>; rel="next"`);
      }
      if (String(input) === pageTwo) {
        return pagedJsonResponse([{
          id: 11,
          tag_name: "v0.1.11-rc.1",
          published_at: "2026-08-01T18:00:00.000Z",
          draft: false,
          prerelease: true,
          assets: [{ id: 1101, name: "TiboTattle-0.1.11-rc.1.dmg", download_count: 12 }],
        }], null);
      }
      throw new Error(`unexpected URL: ${String(input)}`);
    }) as unknown as typeof fetch;
    const overview = await readDistributionAnalytics(
      { enabled: true },
      NOW,
      fetcher,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(overview.github).toMatchObject({
      status: "available",
      summary: { releaseCount: 2, dmgDownloads: 100 },
      releases: [{ tag: "v0.1.12", prerelease: false }, {
        tag: "v0.1.11-rc.1", prerelease: true,
      }],
    });
  });

  it("keeps a valid empty analytics window available with explicit zeroes", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === GITHUB_ENDPOINT
        ? jsonResponse(githubRelease())
        : zoneResponse([])) as unknown as typeof fetch;
    const overview = await readDistributionAnalytics({
      enabled: true,
      cloudflareZoneId: "zone-id",
      cloudflareApiToken: "analytics-secret",
    }, NOW, fetcher);
    expect(overview.cloudflare).toMatchObject({
      status: "available",
      sampled: false,
      bounded: false,
      activeSourceAddresses: { last24Hours: 0, last7Days: 0 },
      currentVersion: "0.1.12",
      currentVersionSourceAddresses: { last24Hours: 0, last7Days: 0 },
      observedVersions: [],
      observedTotals: {
        platforms: [{
          operatingSystem: "windows",
          requestsLast7Days: 0,
          sourceAddressesLast7Days: 0,
        }],
        overall: { requestsLast7Days: 0, sourceAddressesLast7Days: 0 },
      },
    });
    expect(overview.cloudflare.bySegment).toHaveLength(7);
    expect(overview.cloudflare.bySegment.every((segment) => (
      segment.activeSourceAddresses === 0
      && segment.electronCheckRequests === 0
      && segment.currentVersionSourceAddresses === 0
    ))).toBe(true);
  });

  it("degrades failed sources instead of failing the owner overview", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === GITHUB_ENDPOINT
        ? jsonResponse({}, 503)
        : jsonResponse({}, 500)) as unknown as typeof fetch;
    const overview = await readDistributionAnalytics({
      enabled: true,
      cloudflareZoneId: "zone-id",
      cloudflareApiToken: "analytics-secret",
    }, NOW, fetcher);
    expect(overview.cloudflare).toMatchObject({
      status: "unavailable",
      reasonCode: "ANALYTICS_UNAVAILABLE",
      bySegment: [],
      observedTotals: null,
    });
    expect(overview.github).toMatchObject({
      status: "unavailable",
      reasonCode: "GITHUB_UNAVAILABLE",
    });
  });

  it("fails malformed analytics closed and rejects invalid times", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === GITHUB_ENDPOINT
        ? jsonResponse(githubRelease())
        : zoneResponse([{
          count: 1,
          avg: { sampleInterval: 1 },
          dimensions: {
            clientIP: 123,
            userAgent: "TiboTattle/0.1.12",
            edgeResponseStatus: 200,
          },
        }])) as unknown as typeof fetch;
    const overview = await readDistributionAnalytics({
      enabled: true,
      cloudflareZoneId: "zone-id",
      cloudflareApiToken: "analytics-secret",
    }, NOW, fetcher);
    expect(overview.cloudflare).toMatchObject({
      status: "unavailable",
      reasonCode: "ANALYTICS_UNAVAILABLE",
    });
    await expect(readDistributionAnalytics(
      { enabled: false },
      Number.NaN,
      fetcher,
    )).rejects.toThrow("invalid analytics time");
  });
});
