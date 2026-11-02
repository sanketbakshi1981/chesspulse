'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

function publish(t, mode = 'success') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chessquest-deploy-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'stub');
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const mode = process.env.DEPLOY_TEST_MODE;
fs.appendFileSync(process.env.DEPLOY_TEST_LOG, JSON.stringify([tool, ...args]) + '\\n');
if (tool === 'npm') {
  if (mode === 'build-failure') process.exit(1);
  const destination = args[args.indexOf('--prefix') + 1];
  fs.mkdirSync(path.join(destination, 'node_modules'));
  fs.writeFileSync(path.join(destination, 'node_modules', 'production-dependency.js'), '');
}
if (tool === 'az') {
  const command = args.slice(0, 2).join(' ');
  if (command === 'webapp show') console.log(args.includes('serverFarmId') ? '/plan' : 'example.azurewebsites.net');
  if (args.slice(0, 3).join(' ') === 'appservice plan show') console.log(mode === 'multiple-instances' ? '2' : '1');
  if (command === 'webapp deploy') {
    const archive = args[args.indexOf('--src-path') + 1];
    fs.writeFileSync(process.env.DEPLOY_TEST_CONTENTS, execFileSync('unzip', ['-Z1', archive]));
    if (mode === 'deploy-failure') process.exit(1);
  }
}
if (tool === 'curl') {
  if (mode === 'health-failure') process.exit(22);
  console.log('{"ok":true}');
}
`, { mode: 0o755 });
  for (const name of ['az', 'npm', 'curl']) fs.symlinkSync(executable, path.join(directory, name));
  const log = path.join(directory, 'commands.jsonl');
  const contents = path.join(directory, 'contents.txt');
  const result = spawnSync('bash', ['infra/publish.sh'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      AZURE_RESOURCE_GROUP: 'test-group',
      AZURE_WEBAPP_NAME: 'test-app',
      DEPLOY_TEST_MODE: mode,
      DEPLOY_TEST_LOG: log,
      DEPLOY_TEST_CONTENTS: contents,
    },
  });
  return {
    ...result,
    calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [],
    entries: fs.existsSync(contents) ? fs.readFileSync(contents, 'utf8').trim().split('\n') : [],
  };
}

test('App Service publish packages only runtime files and replaces a stopped single instance', (t) => {
  const result = publish(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Deployment healthy: https:\/\/example.azurewebsites.net/);
  assert.deepEqual(result.calls.filter(([tool]) => tool === 'az')
    .map(([, ...args]) => args.slice(0, 2).join(' ')),
  ['webapp show', 'appservice plan', 'webapp show', 'webapp stop', 'webapp deploy', 'webapp start']);
  const install = result.calls.find(([tool]) => tool === 'npm');
  assert.deepEqual(install.slice(1, 3), ['ci', '--omit=dev']);
  assert.equal(result.calls.at(-1)[0], 'curl');
  assert.equal(result.calls.at(-1).at(-1), 'https://example.azurewebsites.net/healthz');
  const deploy = result.calls.find((call) => call[1] === 'webapp' && call[2] === 'deploy');
  assert.equal(deploy[deploy.indexOf('--restart') + 1], 'false');
  assert.equal(deploy[deploy.indexOf('--async') + 1], 'false');
  assert.ok(result.entries.includes('src/server.js'));
  assert.ok(result.entries.includes('node_modules/production-dependency.js'));
  assert.ok(result.entries.includes('package-lock.json'));
  assert.ok(result.entries.includes('public/index.html'));
  assert.ok(result.entries.every((entry) => /^(src\/|public\/|node_modules\/|package(-lock)?\.json$)/.test(entry)));
  assert.ok(!fs.existsSync(path.dirname(install.at(-1))), 'Temporary deployment files must be removed.');
});

for (const mode of ['build-failure', 'multiple-instances', 'deploy-failure', 'health-failure']) {
  test(`App Service publish reports ${mode} without false success`, (t) => {
    const result = publish(t, mode);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /Deployment healthy/);
    const commands = result.calls.map((call) => call.slice(0, 3).join(' '));
    if (mode === 'build-failure' || mode === 'multiple-instances') {
      assert.ok(!commands.includes('az webapp stop'), 'Preflight failures must not stop the running app.');
    } else {
      assert.match(result.stderr, /Deployment failed after stopping the app/);
      if (mode === 'deploy-failure') assert.ok(!commands.includes('az webapp start'));
    }
  });
}
