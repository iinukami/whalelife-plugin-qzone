/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { build } from 'esbuild';
import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const target = resolve('dist/qzone');
await mkdir(target + '/sub/gallery', { recursive: true });
for (const [entry,out] of [['src/index.ts','index.ts'],['src/gallery.ts','sub/gallery/index.ts']]) await build({entryPoints:[entry],outfile:target+'/'+out,bundle:true,platform:'node',format:'esm',target:'node24',packages:'external'});
for(const name of ['plugin.yaml','README.md','LICENSE','LICENSE-ADDITIONAL','NOTICE.md','THIRD_PARTY_NOTICES.md','sub/gallery/plugin.yaml'])await copyFile(name,target+'/'+name);
await mkdir(target+'/scripts',{recursive:true});
await copyFile('scripts/qzone-gallery-migration.mjs',target+'/scripts/qzone-gallery-migration.mjs');
const pkg=JSON.parse(await readFile('package.json','utf8'));delete pkg.devDependencies;delete pkg.scripts;
await writeFile(target+'/package.json',JSON.stringify(pkg,null,2));
const npm=resolve(process.execPath,'..','node_modules/npm/bin/npm-cli.js');
const result=spawnSync(process.execPath,[npm,'install','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:target,stdio:'inherit',windowsHide:true});
if(result.status!==0)throw Error('Dependency installation failed');
console.log('Built '+target);
