#!/usr/bin/env node

const DEFAULT_SCENARIOS = [
  {
    id: 'earnings-history',
    issue: '#1110',
    method: 'GET',
    path: '/users/me/earnings',
    authRequired: true,
    notes: 'Exercises the authenticated earnings aggregation path for long-tenured users.',
  },
  {
    id: 'user-search-growth',
    issue: '#1111',
    method: 'GET',
    path: `/users/search?q=${encodeURIComponent(process.env.BRANDBLITZ_SEARCH_QUERY || 'brand')}`,
    authRequired: false,
    notes: 'Exercises search latency as the users table grows and indexes become important.',
  },
  {
    id: 'public-profile-spike',
    issue: '#1112',
    method: 'GET',
    path: `/users/${encodeURIComponent(process.env.BRANDBLITZ_PUBLIC_USERNAME || 'demo')}/public`,
    authRequired: false,
    notes: 'Approximates repeated viral traffic to one public profile before cache tuning.',
  },
  {
    id: 'question-preview-concurrency',
    issue: '#1114',
    method: 'GET',
    path: `/brands/${encodeURIComponent(process.env.BRANDBLITZ_BRAND_ID || 'demo')}/questions/preview`,
    authRequired: true,
    notes: 'Exercises concurrent brand onboarding preview generation.',
  },
];

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function listFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const values = raw
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0);
  return values.length ? values : fallback;
}

const config = {
  baseUrl: process.env.BRANDBLITZ_API_BASE_URL || 'http://localhost:3000',
  token: process.env.BRANDBLITZ_AUTH_TOKEN || '',
  requestsPerStep: numberFromEnv('BRANDBLITZ_REQUESTS_PER_STEP', 120),
  concurrencySteps: listFromEnv('BRANDBLITZ_CONCURRENCY_STEPS', [10, 50, 100]),
  delayMs: numberFromEnv('BRANDBLITZ_DELAY_MS', 0),
};

function percentile(values, target) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((target / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(index, 0), sorted.length - 1)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildHeaders(scenario) {
  const headers = { Accept: 'application/json' };
  if (scenario.authRequired && config.token) {
    headers.Authorization = `Bearer ${config.token}`;
  }
  return headers;
}

async function timedRequest(scenario) {
  const startedAt = performance.now();
  const url = new URL(scenario.path, config.baseUrl).toString();

  try {
    const response = await fetch(url, {
      method: scenario.method,
      headers: buildHeaders(scenario),
    });

    await response.arrayBuffer();
    return {
      ok: response.ok,
      status: response.status,
      durationMs: performance.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      status: 'network-error',
      durationMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runStep(scenario, concurrency) {
  const totalRequests = Math.max(config.requestsPerStep, concurrency);
  const results = [];
  let cursor = 0;

  async function worker() {
    while (cursor < totalRequests) {
      cursor += 1;
      results.push(await timedRequest(scenario));
      if (config.delayMs > 0) await sleep(config.delayMs);
    }
  }

  const startedAt = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsedMs = performance.now() - startedAt;
  const durations = results.map((result) => result.durationMs);
  const failures = results.filter((result) => !result.ok).length;

  return {
    concurrency,
    totalRequests,
    elapsedMs: Math.round(elapsedMs),
    requestsPerSecond: Number((totalRequests / (elapsedMs / 1000)).toFixed(2)),
    successRate: Number((((totalRequests - failures) / totalRequests) * 100).toFixed(2)),
    failures,
    minMs: Math.round(Math.min(...durations)),
    medianMs: Math.round(percentile(durations, 50)),
    p95Ms: Math.round(percentile(durations, 95)),
    maxMs: Math.round(Math.max(...durations)),
    statusCounts: results.reduce((counts, result) => {
      counts[result.status] = (counts[result.status] || 0) + 1;
      return counts;
    }, {}),
  };
}

async function run() {
  const scenarios = DEFAULT_SCENARIOS.filter((scenario) => {
    if (!scenario.authRequired) return true;
    if (config.token) return true;
    console.warn(`Skipping ${scenario.id}: set BRANDBLITZ_AUTH_TOKEN to exercise this authenticated path.`);
    return false;
  });

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: config.baseUrl,
    requestsPerStep: config.requestsPerStep,
    concurrencySteps: config.concurrencySteps,
    scenarios: [],
  };

  for (const scenario of scenarios) {
    const scenarioReport = {
      id: scenario.id,
      issue: scenario.issue,
      method: scenario.method,
      path: scenario.path,
      notes: scenario.notes,
      steps: [],
    };

    for (const concurrency of config.concurrencySteps) {
      scenarioReport.steps.push(await runStep(scenario, concurrency));
    }

    report.scenarios.push(scenarioReport);
  }

  console.log(JSON.stringify(report, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});