import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

// Browser entry scripts are ES modules. Checking an ambiguous .js filename alone
// can miss a module parse failure; always provide the source with an explicit type.
for (const directory of ['v6', 'v7']) {
  const root = fileURLToPath(new URL(`../static/${directory}/`, import.meta.url));
  for (const name of fs.readdirSync(root).filter(name => /\.(?:m?js)$/.test(name))) {
    test(`browser ES module parses: ${directory}/${name}`, () => {
      const source = fs.readFileSync(path.join(root, name), 'utf8');
      const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
        input: source, encoding: 'utf8', timeout: 10000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr || result.stdout);
    });
  }
}
