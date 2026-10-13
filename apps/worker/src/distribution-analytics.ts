import {
  githubUnavailable,
  readGithubDistributionInventory,
  type DistributionSourceStatus,
  type GithubDistributionAnalytics,
} from "./github-distribution-history";

export type { GithubDistributionAnalytics } from "./github-distribution-history";

const ANALYTICS_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
// The reviewed update origin from config/deployment-endpoints.js (sparkle.origin).
const UPDATE_HOST = "updates.tibotattle.com";
const LOOKBACK_DAYS = 7 as const;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
const GRAPHQL_ROW_LIMIT = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const FETCH_TIMEOUT_MILLISECONDS = 8_000;
const MAX_RENDERED_VERSIONS = 24;

// TiboTattle is Windows x64 only. The single observed update feed is the
// Windows Electron manifest; the retired native, Sparkle, macOS and Linux
// feeds are deliberately not queried, so they are never presented as zero.
const ANALYTICS_QUERY = `
  query TiboTattleDistribution($zoneTag: string, $start: Time, $end: Time) {
    viewer {
      zones(filter: { zoneTag: $zoneTag }) {
        electronWindowsX64: httpRequestsAdaptiveGroups(
          limit: ${GRAPHQL_ROW_LIMIT}
          filter: {
            datetime_geq: $start
            datetime_lt: $end
            clientRequestHTTPHost: "${UPDATE_HOST}"
            clientRequestPath: "/electron/stable/win32-x64/latest.yml"
            requestSource: "eyeball"
          }
        ) {
          count
          avg { sampleInterval }
          dimensions { clientIP userAgent edgeResponseStatus }
        }
      }
    }
  }
`;

type SourceStatus = DistributionSourceStatus;

export interface DistributionAnalyticsConfiguration {
  /** Disable all external reads outside the production owner console. */
  readonly enabled: boolean;
  readonly cloudflareZoneId?: unknown;
  readonly cloudflareApiToken?: unknown;
  readonly githubApiToken?: unknown;
  /**
   * Production overview passes the durable snapshot here. Keeping the fetch
   * path injectable preserves the small live-reader contract used in tests and
   * avoids every browser refresh polling GitHub.
   */
  readonly githubSnapshot?: GithubDistributionAnalytics;
}

export interface DistributionWindowCounts {
  readonly last24Hours: number;
  readonly last7Days: number;
}

export interface DistributionRequestCounts {
  readonly requests: DistributionWindowCounts;
  readonly sourceAddresses: DistributionWindowCounts;
}

export interface DistributionVersionActivity {
  readonly client: "electron";
  readonly operatingSystem: "windows";
  readonly architecture: "x64";
  readonly version: string | null;
  readonly requestsLast7Days: number;
  readonly sourceAddressesLast7Days: number;
}

export interface DistributionObservedPlatformTotals {
  readonly operatingSystem: DistributionVersionActivity["operatingSystem"];
  readonly requestsLast7Days: number;
  readonly sourceAddressesLast7Days: number;
}

export interface DistributionObservedTotals {
  readonly platforms: readonly DistributionObservedPlatformTotals[];
  readonly overall: {
    readonly requestsLast7Days: number;
    readonly sourceAddressesLast7Days: number;
  };
}

export interface DistributionActivitySegment {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly activeSourceAddresses: number;
  readonly electronCheckRequests: number;
  readonly currentVersionSourceAddresses: number | null;
}

export interface CloudflareDistributionAnalytics {
  readonly status: SourceStatus;
  readonly reasonCode: string | null;
  readonly sampled: boolean | null;
  readonly bounded: boolean | null;
  readonly window: {
    readonly startsAt: string;
    readonly endsAt: string;
  } | null;
  readonly activeSourceAddresses: DistributionWindowCounts | null;
  readonly electronChecks: DistributionRequestCounts | null;
  readonly currentVersion: string | null;
  readonly currentVersionSourceAddresses: DistributionWindowCounts | null;
  /**
   * The same seven already-fetched 24-hour segments used for the rolling
   * totals, reduced to aggregate chart points. No additional analytics query
   * or raw source address crosses this boundary.
   */
  readonly bySegment: readonly DistributionActivitySegment[];
  readonly observedVersions: readonly DistributionVersionActivity[];
  readonly observedVersionsBounded: boolean;
  readonly observedTotals: DistributionObservedTotals | null;
}

export interface DistributionAnalyticsOverview {
  readonly methodology: {
    readonly unit: "distinct_source_ip_addresses";
    readonly lookbackDays: 7;
    readonly storesRawAddresses: false;
  };
  readonly cloudflare: CloudflareDistributionAnalytics;
  readonly github: GithubDistributionAnalytics;
}

interface AnalyticsRow {
  readonly count: number;
  readonly sampleInterval: number;
  readonly clientIP: string;
  readonly userAgent: string;
  readonly edgeResponseStatus: number;
}

interface AnalyticsSegment {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly rows: readonly AnalyticsRow[];
  readonly bounded: boolean;
}

interface VersionAccumulator {
  requestsLast7Days: number;
  readonly sourceAddressesLast24Hours: Set<string>;
  readonly sourceAddressesLast7Days: Set<string>;
}

interface ObservedTotalsAccumulator {
  requestsLast7Days: number;
  readonly sourceAddressesLast7Days: Set<string>;
}

function configuredString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid external analytics response");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("invalid external analytics response");
  }
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("invalid external analytics response");
  }
  return value;
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("invalid external analytics response");
  }
  return Number(value);
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("external analytics count overflow");
  }
  return result;
}

function sourceUnavailable(
  status: Exclude<SourceStatus, "available">,
  reasonCode: string,
): CloudflareDistributionAnalytics {
  return {
    status,
    reasonCode,
    sampled: null,
    bounded: null,
    window: null,
    activeSourceAddresses: null,
    electronChecks: null,
    currentVersion: null,
    currentVersionSourceAddresses: null,
    bySegment: [],
    observedVersions: [],
    observedVersionsBounded: false,
    observedTotals: null,
  };
}

async function fetchWithTimeout(
  fetcher: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort("distribution analytics timeout"),
    FETCH_TIMEOUT_MILLISECONDS,
  );
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isFinite(parsedLength)
        || parsedLength < 0
        || parsedLength > MAX_RESPONSE_BYTES) {
      throw new Error("external analytics response too large");
    }
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("external analytics response too large");
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("invalid external analytics response");
  }
}

function parseAnalyticsRows(value: unknown): readonly AnalyticsRow[] {
  return array(value).map((item) => {
    const row = record(item);
    const average = record(row.avg);
    const dimensions = record(row.dimensions);
    const sampleInterval = Number(average.sampleInterval);
    const edgeResponseStatus = Number(dimensions.edgeResponseStatus);
    const clientIP = string(dimensions.clientIP);
    const rawUserAgent = dimensions.userAgent;
    if (!Number.isFinite(sampleInterval) || sampleInterval < 1
        || !Number.isSafeInteger(edgeResponseStatus)
        || edgeResponseStatus < 100
        || edgeResponseStatus > 599
        || clientIP.length > 128
        || (rawUserAgent !== null
          && rawUserAgent !== undefined
          && typeof rawUserAgent !== "string")) {
      throw new Error("invalid external analytics response");
    }
    return {
      count: count(row.count),
      sampleInterval,
      clientIP,
      userAgent: typeof rawUserAgent === "string"
        ? rawUserAgent.slice(0, 2_048)
        : "",
      edgeResponseStatus,
    };
  });
}

function parseAnalyticsResponse(
  value: unknown,
  startsAt: string,
  endsAt: string,
): AnalyticsSegment {
  const root = record(value);
  if (root.errors !== undefined
      && root.errors !== null
      && array(root.errors).length > 0) {
    throw new Error("external analytics query failed");
  }
  const data = record(root.data);
  const viewer = record(data.viewer);
  const zones = array(viewer.zones);
  if (zones.length !== 1) {
    throw new Error("invalid external analytics response");
  }
  const zone = record(zones[0]);
  const rows = parseAnalyticsRows(zone.electronWindowsX64);
  return {
    startsAt,
    endsAt,
    rows,
    bounded: rows.length >= GRAPHQL_ROW_LIMIT,
  };
}

async function readAnalyticsSegment(
  zoneId: string,
  apiToken: string,
  startsAt: string,
  endsAt: string,
  fetcher: typeof fetch,
): Promise<AnalyticsSegment> {
  const response = await fetchWithTimeout(fetcher, ANALYTICS_ENDPOINT, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: ANALYTICS_QUERY,
      variables: { zoneTag: zoneId, start: startsAt, end: endsAt },
    }),
  });
  if (!response.ok) {
    throw new Error("external analytics query failed");
  }
  return parseAnalyticsResponse(await boundedJson(response), startsAt, endsAt);
}

function analyticsSegments(nowEpoch: number): readonly {
  startsAt: string;
  endsAt: string;
}[] {
  const firstStart = nowEpoch - LOOKBACK_DAYS * DAY_MILLISECONDS;
  return Array.from({ length: LOOKBACK_DAYS }, (_, index) => {
    const startsAtEpoch = firstStart + index * DAY_MILLISECONDS;
    return {
      startsAt: new Date(startsAtEpoch).toISOString(),
      endsAt: new Date(startsAtEpoch + DAY_MILLISECONDS).toISOString(),
    };
  });
}

function isSuccessfulCheck(status: number): boolean {
  return (status >= 200 && status < 300) || status === 304;
}

/** Only TiboTattle's own Electron updater clients count as observed checks. */
function isWindowsUpdateClient(userAgent: string): boolean {
  const agent = userAgent.toLowerCase();
  return agent.includes("tibotattle/")
    || agent.includes("electron/")
    || agent.includes("electron-updater")
    || agent.includes("electron-builder");
}

function appVersion(userAgent: string): string | null {
  return userAgent.match(
    /TiboTattle\/([0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?)/u,
  )?.[1] ?? null;
}

function releaseVersion(tag: string): string | null {
  const value = tag.startsWith("v") ? tag.slice(1) : tag;
  return /^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/u.test(value)
    ? value
    : null;
}

function addRequest(
  row: AnalyticsRow,
  inLast24Hours: boolean,
  accumulator: {
    requestsLast24Hours: number;
    requestsLast7Days: number;
    readonly sourceAddressesLast24Hours: Set<string>;
    readonly sourceAddressesLast7Days: Set<string>;
  },
): void {
  accumulator.requestsLast7Days = safeAdd(
    accumulator.requestsLast7Days,
    row.count,
  );
  accumulator.sourceAddressesLast7Days.add(row.clientIP);
  if (inLast24Hours) {
    accumulator.requestsLast24Hours = safeAdd(
      accumulator.requestsLast24Hours,
      row.count,
    );
    accumulator.sourceAddressesLast24Hours.add(row.clientIP);
  }
}

function requestAccumulator(): {
  requestsLast24Hours: number;
  requestsLast7Days: number;
  readonly sourceAddressesLast24Hours: Set<string>;
  readonly sourceAddressesLast7Days: Set<string>;
} {
  return {
    requestsLast24Hours: 0,
    requestsLast7Days: 0,
    sourceAddressesLast24Hours: new Set(),
    sourceAddressesLast7Days: new Set(),
  };
}

function projectRequestAccumulator(
  value: ReturnType<typeof requestAccumulator>,
): DistributionRequestCounts {
  return {
    requests: {
      last24Hours: value.requestsLast24Hours,
      last7Days: value.requestsLast7Days,
    },
    sourceAddresses: {
      last24Hours: value.sourceAddressesLast24Hours.size,
      last7Days: value.sourceAddressesLast7Days.size,
    },
  };
}

function aggregateAnalytics(
  segments: readonly AnalyticsSegment[],
  currentVersion: string | null,
): CloudflareDistributionAnalytics {
  if (segments.length !== LOOKBACK_DAYS) {
    throw new Error("incomplete external analytics window");
  }
  const activeAddressesLast24Hours = new Set<string>();
  const activeAddressesLast7Days = new Set<string>();
  const electronChecks = requestAccumulator();
  const bySegment: DistributionActivitySegment[] = [];
  // Keyed by the reported app version; the empty key is an unversioned client.
  const versions = new Map<string, VersionAccumulator>();
  const observedWindowsTotals: ObservedTotalsAccumulator = {
    requestsLast7Days: 0,
    sourceAddressesLast7Days: new Set<string>(),
  };
  let sampled = false;
  let bounded = false;

  segments.forEach((segment, index) => {
    const inLast24Hours = index === segments.length - 1;
    const segmentActiveAddresses = new Set<string>();
    const segmentCurrentVersionAddresses = new Set<string>();
    let segmentElectronCheckRequests = 0;
    bounded ||= segment.bounded;
    for (const row of segment.rows) {
      sampled ||= row.sampleInterval > 1;
    }
    for (const row of segment.rows) {
      if (!isSuccessfulCheck(row.edgeResponseStatus)) continue;
      if (!isWindowsUpdateClient(row.userAgent)) continue;
      activeAddressesLast7Days.add(row.clientIP);
      segmentActiveAddresses.add(row.clientIP);
      if (inLast24Hours) activeAddressesLast24Hours.add(row.clientIP);
      observedWindowsTotals.requestsLast7Days = safeAdd(
        observedWindowsTotals.requestsLast7Days,
        row.count,
      );
      observedWindowsTotals.sourceAddressesLast7Days.add(row.clientIP);
      addRequest(row, inLast24Hours, electronChecks);
      segmentElectronCheckRequests = safeAdd(
        segmentElectronCheckRequests,
        row.count,
      );
      const version = appVersion(row.userAgent) ?? "";
      const accumulator = versions.get(version) ?? {
        requestsLast7Days: 0,
        sourceAddressesLast24Hours: new Set<string>(),
        sourceAddressesLast7Days: new Set<string>(),
      };
      accumulator.requestsLast7Days = safeAdd(
        accumulator.requestsLast7Days,
        row.count,
      );
      accumulator.sourceAddressesLast7Days.add(row.clientIP);
      if (inLast24Hours) {
        accumulator.sourceAddressesLast24Hours.add(row.clientIP);
      }
      versions.set(version, accumulator);
      if (currentVersion !== null && version === currentVersion) {
        segmentCurrentVersionAddresses.add(row.clientIP);
      }
    }
    bySegment.push({
      startsAt: segment.startsAt,
      endsAt: segment.endsAt,
      activeSourceAddresses: segmentActiveAddresses.size,
      electronCheckRequests: segmentElectronCheckRequests,
      currentVersionSourceAddresses: currentVersion === null
        ? null
        : segmentCurrentVersionAddresses.size,
    });
  });

  const observedVersions = [...versions.entries()]
    .map(([version, value]): DistributionVersionActivity => ({
      client: "electron",
      operatingSystem: "windows",
      architecture: "x64",
      version: version.length === 0 ? null : version,
      requestsLast7Days: value.requestsLast7Days,
      sourceAddressesLast7Days: value.sourceAddressesLast7Days.size,
    }))
    .sort((left, right) =>
      right.sourceAddressesLast7Days - left.sourceAddressesLast7Days
      || right.requestsLast7Days - left.requestsLast7Days
      || (left.version ?? "").localeCompare(right.version ?? ""))
    .slice(0, MAX_RENDERED_VERSIONS);
  const observedTotals: DistributionObservedTotals = {
    platforms: [{
      operatingSystem: "windows",
      requestsLast7Days: observedWindowsTotals.requestsLast7Days,
      sourceAddressesLast7Days: observedWindowsTotals.sourceAddressesLast7Days.size,
    }],
    overall: {
      requestsLast7Days: observedWindowsTotals.requestsLast7Days,
      sourceAddressesLast7Days: observedWindowsTotals.sourceAddressesLast7Days.size,
    },
  };
  const currentVersionTotals = currentVersion === null
    ? undefined
    : versions.get(currentVersion);

  return {
    status: "available",
    reasonCode: null,
    sampled,
    bounded,
    window: {
      startsAt: segments[0]?.startsAt ?? "",
      endsAt: segments.at(-1)?.endsAt ?? "",
    },
    activeSourceAddresses: {
      last24Hours: activeAddressesLast24Hours.size,
      last7Days: activeAddressesLast7Days.size,
    },
    electronChecks: projectRequestAccumulator(electronChecks),
    currentVersion,
    currentVersionSourceAddresses: currentVersion === null
      ? null
      : {
        last24Hours: currentVersionTotals?.sourceAddressesLast24Hours.size ?? 0,
        last7Days: currentVersionTotals?.sourceAddressesLast7Days.size ?? 0,
      },
    bySegment,
    observedVersions,
    observedVersionsBounded: versions.size > MAX_RENDERED_VERSIONS,
    observedTotals,
  };
}

/**
 * Reads only aggregate distribution evidence for the Access-protected owner
 * console. Cloudflare source addresses exist only in this function's transient
 * memory and are reduced to counts before the response is returned.
 */
export async function readDistributionAnalytics(
  configuration: DistributionAnalyticsConfiguration,
  nowEpoch = Date.now(),
  fetcher: typeof fetch = fetch,
): Promise<DistributionAnalyticsOverview> {
  if (!Number.isFinite(nowEpoch)) throw new Error("invalid analytics time");
  const methodology = {
    unit: "distinct_source_ip_addresses" as const,
    lookbackDays: LOOKBACK_DAYS,
    storesRawAddresses: false as const,
  };
  if (!configuration.enabled) {
    return {
      methodology,
      cloudflare: sourceUnavailable("not_configured", "DISTRIBUTION_DISABLED"),
      github: githubUnavailable("not_configured", "DISTRIBUTION_DISABLED"),
    };
  }
  const zoneId = configuredString(configuration.cloudflareZoneId);
  const cloudflareApiToken = configuredString(configuration.cloudflareApiToken);
  const githubPromise = configuration.githubSnapshot === undefined
    ? readGithubDistributionInventory(configuration.githubApiToken, fetcher)
    : Promise.resolve(configuration.githubSnapshot);
  const analyticsPromise = zoneId === null || cloudflareApiToken === null
    ? Promise.resolve<readonly AnalyticsSegment[] | null>(null)
    : Promise.all(
      analyticsSegments(nowEpoch).map(({ startsAt, endsAt }) =>
        readAnalyticsSegment(
          zoneId,
          cloudflareApiToken,
          startsAt,
          endsAt,
          fetcher,
        )),
    ).catch(() => [] as readonly AnalyticsSegment[]);
  const [segments, github] = await Promise.all([analyticsPromise, githubPromise]);
  let cloudflare: CloudflareDistributionAnalytics;
  if (segments === null) {
    cloudflare = sourceUnavailable(
      "not_configured",
      "ANALYTICS_NOT_CONFIGURED",
    );
  } else if (segments.length !== LOOKBACK_DAYS) {
    cloudflare = sourceUnavailable("unavailable", "ANALYTICS_UNAVAILABLE");
  } else {
    try {
      cloudflare = aggregateAnalytics(
        segments,
        github.release === null ? null : releaseVersion(github.release.tag),
      );
    } catch {
      cloudflare = sourceUnavailable("unavailable", "ANALYTICS_UNAVAILABLE");
    }
  }
  return { methodology, cloudflare, github };
}
