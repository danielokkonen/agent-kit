import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

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
// npm run sets cwd to the project root; this script may live outside the repo (global skill).
const startDir = fs.existsSync(path.join(process.cwd(), 'package.json')) ? process.cwd() : scriptDir;
const projectDir = findProjectDir(startDir);

// Resolve deps from the project, not this (possibly global) script's location.
const require = createRequire(path.join(projectDir, 'package.json'));
const { build, loadConfigFromFile } = require('vite');

// vite.base.config.ts hot-restart plugin reads this global; forge only sets it in serve mode.
process.viteDevServers ??= {};

// Mirrors the VitePlugin entries in forge.config.ts.
const MAIN_ENTRY = { entry: 'src/main.ts', config: 'vite.main.config.ts' };
const PRELOAD_ENTRY = { entry: 'src/preload.ts', config: 'vite.preload.config.ts' };
const RENDERER_ENTRY = { name: 'main_window', config: 'vite.renderer.config.ts' };

const mainGetConfig = require('@electron-forge/plugin-vite/dist/config/vite.main.config').getConfig;
const preloadGetConfig = require('@electron-forge/plugin-vite/dist/config/vite.preload.config').getConfig;
const rendererGetConfig = require('@electron-forge/plugin-vite/dist/config/vite.renderer.config').getConfig;

function forgeEnv(target) {
  return {
    command: 'build',
    mode: 'production',
    root: projectDir,
    forgeConfig: { renderer: [RENDERER_ENTRY] },
    forgeConfigSelf: target,
  };
}

async function buildTarget(getConfig, target) {
  const env = forgeEnv(target);
  const userConfig = (await loadConfigFromFile(env, target.config, projectDir))?.config;
  await build({ configFile: false, ...getConfig(env, userConfig) });
}

const expectedOutputs = [
  '.vite/build/main.js',
  '.vite/build/preload.js',
  `.vite/renderer/${RENDERER_ENTRY.name}/index.html`,
];

try {
  await buildTarget(mainGetConfig, MAIN_ENTRY);
  console.log('Built main');
  await buildTarget(preloadGetConfig, PRELOAD_ENTRY);
  console.log('Built preload');
  await buildTarget(rendererGetConfig, RENDERER_ENTRY);
  console.log('Built renderer');

  const missing = expectedOutputs.filter((out) => !fs.existsSync(path.join(projectDir, out)));
  if (missing.length > 0) {
    throw new Error(`Expected outputs missing after build: ${missing.join(', ')}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
