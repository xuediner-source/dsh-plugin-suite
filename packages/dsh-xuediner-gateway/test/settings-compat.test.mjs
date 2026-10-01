import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { boot, initProfile, readProfilePatches } from '@deepseek-ai/dsh-app-boot';
import ConfigEditor from '@deepseek-ai/dsh-config-editor';
import Settings from '@deepseek-ai/dsh-settings';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import { resolveApiKey } from '../lib/index.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(testDir, '..');
const suiteRoot = resolve(packageDir, '../..');

test('native Loader and SettingsForms expose and apply gateway connection edits by Loader id', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-gateway-settings-'));
  let ctx;
  try {
    const profileDir = join(home, 'profiles', 'test');
    initProfile(profileDir, ['dsh-xuediner-gateway']);
    const bundleDir = join(profileDir, 'node_modules', 'dsh-xuediner-gateway');
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(home, 'package.json'), '{"name":"dsh-gateway-settings-test"}\n');
    await writeFile(join(bundleDir, 'package.json'), JSON.stringify({
      name: 'dsh-xuediner-gateway',
      version: '0.2.0',
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }));
    await copyFile(join(packageDir, 'cordis.patch.yml'), join(bundleDir, 'cordis.patch.yml'));

    const compositionPath = join(profileDir, 'cordis.yml');
    await writeFile(compositionPath, [
      '- id: config-editor',
      '  name: "cordis:editor"',
      '- id: settings',
      '  name: "cordis:settings"',
      '- id: llm',
      '  name: "cordis:llm"',
      '',
    ].join('\n'));
    const profile = {
      name: 'test',
      startedBundles: ['dsh-xuediner-gateway'],
      dir: profileDir,
      patchPath: join(profileDir, 'cordis.patch.yml'),
      installAnchor: join(home, 'package.json'),
      cwd: home,
      home,
      overlays: [],
      telemetryDisabledEnv: undefined,
    };

    const patches = readProfilePatches('gateway-settings-test', profile);
    ctx = await boot(
      'gateway-settings-test',
      compositionPath,
      patches,
      root => {
        root.provide('profileContext', profile);
        Object.assign(root.loader.builtins, {
          editor: ConfigEditor,
          settings: Settings,
          llm: LlmRuntime,
        });
      },
      pathToFileURL(suiteRoot + sep).href,
    );

    const provider = ctx.llm.listConfigurableProviders().find(row => row.provider === 'xuedinerAPI');
    assert.equal(provider?.settingsNs, 'xuediner-gateway');
    assert.deepEqual(provider?.settingsPath, []);

    const entry = ctx.configEditor.entries().find(row => row.options.id === 'xuediner-gateway');
    assert.ok(entry?.fiber, 'the bundled provider entry is active');
    const fiber = entry.fiber;
    const before = ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === 'xuediner-gateway');
    assert.ok(before, 'the published SettingsForms service projects the plugin Config');
    assert.equal(before.value.baseURL, 'http://127.0.0.1:7863/v1');
    assert.equal(before.value.apiKeyEnv, 'XUEDINER_API_KEY');
    assert.match(JSON.stringify(before.schema), /credential-ref/);

    await ctx.settings.update('xuediner-gateway', {
      baseURL: 'http://127.0.0.1:8765/v1',
      apiKeyEnv: 'DSH_TEST_GATEWAY_KEY_REF',
    }, before.revision);

    const current = ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === 'xuediner-gateway');
    assert.equal(current?.value.baseURL, 'http://127.0.0.1:8765/v1');
    assert.equal(current?.value.apiKeyEnv, 'DSH_TEST_GATEWAY_KEY_REF');
    assert.equal(ctx.configEditor.entries().find(row => row.options.id === 'xuediner-gateway')?.fiber, fiber,
      'volatile form edits update in place');
    assert.equal(fiber.config.baseURL.get(), 'http://127.0.0.1:8765/v1');
    assert.equal(fiber.config.apiKeyEnv.get(), 'DSH_TEST_GATEWAY_KEY_REF');

    const previousTestCredential = process.env.DSH_TEST_GATEWAY_KEY_REF;
    delete process.env.DSH_TEST_GATEWAY_KEY_REF;
    const attemptedRefs = [];
    try {
      await assert.rejects(resolveApiKey({
        get(service) {
          assert.equal(service, 'credentials');
          return { resolve: async ref => { attemptedRefs.push(ref); return undefined; } };
        },
      }, fiber.config), /Configured gateway credential reference could not be resolved/);
      assert.deepEqual(attemptedRefs, ['DSH_TEST_GATEWAY_KEY_REF'],
        'a missing custom reference does not fall through to legacy aliases or the placeholder key');
    } finally {
      if (previousTestCredential === undefined) delete process.env.DSH_TEST_GATEWAY_KEY_REF;
      else process.env.DSH_TEST_GATEWAY_KEY_REF = previousTestCredential;
    }

    const savedPatch = await readFile(profile.patchPath, 'utf8');
    assert.match(savedPatch, /DSH_TEST_GATEWAY_KEY_REF/);
    assert.doesNotMatch(savedPatch, /wb2api-dsh-key|apiKey:\s*[^\n]+/);
  } finally {
    try { await ctx?.fiber.dispose(); } finally { await rm(home, { recursive: true, force: true }); }
  }
});
