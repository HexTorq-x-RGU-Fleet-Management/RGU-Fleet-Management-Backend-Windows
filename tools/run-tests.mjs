import { spawnSync } from 'node:child_process';
const python = process.env.HIK_PYTHON || 'python';
const jobs = [
  ['Source/dependency checks', process.execPath, ['tools/check-source.mjs']],
  [
    'SaaS/API/PostgreSQL tests',
    process.execPath,
    ['--env-file-if-exists=.env', '--test', 'test/*.test.mjs'],
  ],
  ['Native audio tests', python, ['vendor/windows-sdk/native/test_audio.py']],
  ['Native video tests', python, ['vendor/windows-sdk/native/test_smooth.py']],
  ['Installed SDK loading (no cloud calls)', python, ['tools/check-sdk.py']],
];
for (const [label, command, args] of jobs) {
  console.log('\n' + label);
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) {
    console.error('Check failed: ' + label);
    process.exit(result.status || 1);
  }
}
console.log('\nAll configured Windows backend checks passed. Real camera acceptance is separate.');
