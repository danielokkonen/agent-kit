import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EVIDENCE_ROOT = '/tmp/opencode/app-test';
const LAUNCH_TIMEOUT_MS = 60_000;

function findProjectDir(startDir) {
  let dir = startDir;
  while (true) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Could not locate project root (package.json)');
    dir = parent;
  }
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
// Invoked with cwd = the project root; this script may live outside the repo (global skill).
const startDir = fs.existsSync(path.join(process.cwd(), 'package.json')) ? process.cwd() : scriptDir;
const projectDir = findProjectDir(startDir);

// Resolve playwright from the project, not this (possibly global) script's location.
const require = createRequire(path.join(projectDir, 'package.json'));

function usage() {
  console.error('Usage: node run-scenario.mjs <scenario-file> --target <target-file>');
}

function parseArgs(argv) {
  const positional = [];
  let targetFile;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target') {
      targetFile = argv[++i];
    } else {
      positional.push(argv[i]);
    }
  }
  return { scenarioFile: positional[0], targetFile };
}

async function loadModule(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
  return import(pathToFileURL(abs).href);
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function launchTarget(target) {
  if (target.type === 'electron') {
    const { _electron } = require('playwright');
    const app = await _electron.launch({
      args: [target.launch.entry],
      cwd: target.launch.cwd,
      executablePath: target.launch.executablePath,
      timeout: LAUNCH_TIMEOUT_MS,
    });
    const page = await app.firstWindow();
    return { page, close: () => app.close() };
  }
  if (target.type === 'url') {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ timeout: LAUNCH_TIMEOUT_MS });
    const page = await browser.newPage();
    await page.goto(target.launch.baseUrl, { waitUntil: 'domcontentloaded' });
    return { page, close: () => browser.close() };
  }
  throw new Error(`Unknown target type: ${target.type} (expected "electron" or "url")`);
}

function collectConsoleErrors(page) {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`Uncaught exception: ${err.message}`));
  return errors;
}

async function runHooks(assertions, context) {
  for (const assertion of assertions ?? []) {
    const mod = await loadModule(assertion.file);
    await mod.default({ ...assertion.args, ...context });
  }
}

function normalizeSteps(scenario) {
  if (Array.isArray(scenario.steps)) return scenario.steps;
  if (typeof scenario.run === 'function') return [{ title: scenario.name, run: scenario.run }];
  throw new Error('Scenario must export { name, steps: [...] } or { name, run }');
}

async function main() {
  const { scenarioFile, targetFile } = parseArgs(process.argv.slice(2));
  if (!scenarioFile || !targetFile) {
    usage();
    process.exitCode = 2;
    return;
  }

  for (const file of [scenarioFile, targetFile]) {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) {
      console.error(`app-test: File not found: ${abs}`);
      process.exitCode = 2;
      return;
    }
  }

  const [scenarioMod, targetMod] = await Promise.all([loadModule(scenarioFile), loadModule(targetFile)]);
  const scenario = scenarioMod.default;
  const target = targetMod.default;
  if (!scenario?.name) throw new Error('Scenario must default-export an object with a "name"');
  if (!target?.type || !target?.launch) throw new Error('Target config must have { type, launch }');

  const steps = normalizeSteps(scenario);
  const evidenceDir = path.join(EVIDENCE_ROOT, `${slugify(scenario.name)}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(evidenceDir, { recursive: true });

  const launched = await launchTarget(target);
  const consoleErrors = collectConsoleErrors(launched.page);
  const results = [];
  let aborted = false;

  try {
    await runHooks(target.assertions, { cwd: target.launch.cwd, phase: 'launch', stepTitle: '', checks: [] });

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const result = { title: step.title ?? `step ${i + 1}`, status: 'pass' };
      results.push(result);
      try {
        await step.run({ page: launched.page });
        if (step.mutating || Array.isArray(step.assertions)) {
          await runHooks(target.assertions, {
            cwd: target.launch.cwd,
            phase: 'step',
            stepTitle: result.title,
            checks: step.assertions ?? [],
          });
        }
      } catch (err) {
        result.status = 'fail';
        result.error = err.message;
        const screenshot = path.join(evidenceDir, `step-${String(i + 1).padStart(2, '0')}.png`);
        await launched.page.screenshot({ path: screenshot }).catch(() => {});
        result.screenshot = fs.existsSync(screenshot) ? screenshot : null;
        aborted = true;
      }
      if (aborted) break;
    }
  } finally {
    await launched.close().catch(() => {});
  }

  for (const result of results) {
    console.log(`${result.status === 'pass' ? '[PASS]' : '[FAIL]'} ${result.title}`);
    if (result.error) console.log(`       error: ${result.error}`);
    if (result.screenshot) console.log(`       screenshot: ${result.screenshot}`);
  }
  for (let i = results.length; i < steps.length; i++) {
    console.log(`[SKIP] ${steps[i].title ?? `step ${i + 1}`} (previous step failed)`);
  }

  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  console.log(`\nSummary: ${passed} passed, ${failed} failed, ${steps.length - results.length} skipped`);
  if (consoleErrors.length > 0) {
    console.log(`Console errors (${consoleErrors.length}):`);
    for (const text of consoleErrors) console.log(`  - ${text}`);
  }

  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(`app-test: ${err.message}`);
  process.exitCode = 1;
});
