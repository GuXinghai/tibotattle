import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readElectronSitePublication, readPublishedElectronSiteRelease, renderElectronSiteDocumentation, renderElectronSiteDownloads } from '../scripts/lib/electron-public-site.mjs';
import { identityDigest } from '../scripts/lib/release-operation.mjs';
import { validateCanonicalManifest } from '../scripts/release-evidence-policy.js';
import { RELEASE_EVIDENCE_SCHEMA_VERSION } from '../config/release-evidence.js';
import { buildPublicReleaseSite, parseArgs } from '../scripts/build-public-release-site.js';

const hash = b => createHash('sha256').update(b).digest('hex');
const WINDOWS_TARGET = 'win32-x64';
const WINDOWS_NAME = version => `TiboTattle-${version}-Windows-x64.exe`;
// Synthetic PNG/JPEG bytes only; no rendered or hand-copied card enters the repository.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii'), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}
function grayscalePng(width, height) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.alloc((width + 1) * height))), pngChunk('IEND', Buffer.alloc(0))]);
}
// The exact source-owned alt text of the community template's card.
const SOURCE_SOCIAL_ALT = 'The TiboTattle homepage: the community-fitted seven-day Codex allowance in API-equivalent dollars, with its plausible range and daily history, beside the Windows download';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(),'electron-site-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const origin='https://updates.tibotattle.com', targets=[];
  await mkdir(join(root,WINDOWS_TARGET));
  const name=WINDOWS_NAME('0.1.20');
  const object=async name=>{const bytes=Buffer.from('synthetic '+name);await writeFile(join(root,WINDOWS_TARGET,name),bytes);return {objectKey:`electron/stable/${WINDOWS_TARGET}/${name}`,localPath:`${WINDOWS_TARGET}/${name}`,sha256:hash(bytes),bytes:bytes.length};};
  targets.push({target:WINDOWS_TARGET,feedURL:`${origin}/electron/stable/${WINDOWS_TARGET}`,artifacts:[await object(name)],feed:await object('latest.yml')});
  const plan={schemaVersion:'tibotattle-electron-stable-publication-plan-v1',origin,version:'0.1.20',buildNumber:'2026091002',sourceRevision:'1'.repeat(40),status:'local_bytes_bound',published:false,targets};
  const planPath=join(root,'plan.json');await writeFile(planPath,JSON.stringify(plan));
  return {root,plan,planPath,options:{planPath,artifactRoot:root,approvedPlanSha256:identityDigest(plan)}};
}
async function publishedFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'electron-published-site-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const version = '0.1.20', tag = `v${version}`, commit = '1'.repeat(40);
  const repository = 'https://github.com/adamallcock/tibotattle';
  const source = { version, tag, commit, repository };
  const fileName = WINDOWS_NAME(version);
  const bytes = Buffer.byteLength(fileName);
  const artifacts = [{ platform: 'windows', channel: 'direct', architecture: 'x64', format: 'exe', version,
    distribution: 'github-release',
    downloadUrl: `${repository}/releases/download/${tag}/${fileName}`,
    fileName, bytes, sha256: hash(Buffer.from(fileName)), source, store: null, sbom: null, provenance: null,
    build: { sourceManifestSha256: '2'.repeat(64), unsignedPayloadSha256: '3'.repeat(64) },
    nativeTrust: { publisher: 'Test', certificateSha256: '4'.repeat(64) },
    assurances: { authenticodeSigned: true, cleanInstallSmokePassed: true, timestamped: true },
    updater: { enabled: false, mechanism: 'none', metadata: null } }];
  const manifest = { schemaVersion: RELEASE_EVIDENCE_SCHEMA_VERSION, product: { name: 'TiboTattle' },
    version, tag, commit, repository, artifacts };
  validateCanonicalManifest(manifest);
  const manifestPath = join(root, 'release-manifest.json');
  const writeManifest = async () => { const serialized = Buffer.from(`${JSON.stringify(manifest)}\n`);
    await writeFile(manifestPath, serialized); return hash(serialized); };
  const approvedManifestSha256 = await writeManifest();
  return { root, manifest, manifestPath, writeManifest,
    options: { manifestPath, approvedManifestSha256, buildNumber: '2026091002' } };
}

test('published release intake pins canonical evidence and verifies the remote Windows installer bytes', async t => {
  const f = await publishedFixture(t); const calls = [];
  const release = await readPublishedElectronSiteRelease({ ...f.options,
    verifyPublishedInstaller: async value => { calls.push(value); return { bytes: value.expectedBytes, sha256: value.expectedSha256 }; } });
  assert.deepEqual(release.downloads.map(item => item.target), [WINDOWS_TARGET]);
  assert.equal(calls.length, 1);
  assert.deepEqual(release.verificationScope, ['pinned-release-manifest', 'published-installer-bytes']);
  assert.equal(release.publishedInstallersVerified, true);
  await assert.rejects(readPublishedElectronSiteRelease({ ...f.options, approvedManifestSha256: '0'.repeat(64),
    verifyPublishedInstaller: async () => assert.fail('bad pin must fail first') }), /exact reviewed/u);
  f.manifest.artifacts[0].downloadUrl = 'https://example.net/other.exe';
  const changedDigest = await f.writeManifest();
  await assert.rejects(readPublishedElectronSiteRelease({ ...f.options, approvedManifestSha256: changedDigest,
    verifyPublishedInstaller: async () => assert.fail('foreign URL must fail first') }));
});

test('published release intake cannot qualify a preview or combine publication modes', async t => {
  const f = await publishedFixture(t);
  const release = await readPublishedElectronSiteRelease({ ...f.options, verifyPublishedInstaller: async value =>
    ({ bytes: value.expectedBytes, sha256: value.expectedSha256, published: false }) });
  assert.equal(release.publishedInstallersVerified, false);
  assert.deepEqual(release.verificationScope, ['pinned-release-manifest']);
  const social = join(f.root, 'social.png');
  await writeFile(social, await readFile(new URL('../apps/web/public/tibotattle-icon.png', import.meta.url)));
  const args = { output: join(f.root, 'output'), siteUrl: 'https://tibotattle.com/',
    releaseNotesUrl: 'https://github.com/adamallcock/tibotattle/releases/tag/v0.1.20',
    privacyUrl: 'https://tibotattle.com/privacy', securityUrl: 'https://tibotattle.com/docs',
    supportUrl: 'https://github.com/adamallcock/tibotattle/issues', socialImage: social,
    electronPublishedManifest: f.manifestPath, electronPublishedManifestSha256: f.options.approvedManifestSha256,
    electronPublishedBuildNumber: f.options.buildNumber };
  let calls = 0;
  await buildPublicReleaseSite(args, { verifyPublishedInstaller: async value => { calls++;
    return { bytes: value.expectedBytes, sha256: value.expectedSha256, published: false }; } });
  assert.equal(calls, 1);
  const manifest = JSON.parse(await readFile(join(args.output, 'release-site-manifest.json'), 'utf8'));
  assert.equal(manifest.electronRelease.publishedInstallersVerified, false);
  assert.deepEqual(manifest.electronRelease.verificationScope, ['pinned-release-manifest']);
  await assert.rejects(buildPublicReleaseSite({ ...args, electronPublicationPlan: f.manifestPath }), /requires all three explicit inputs/u);
  const linkPath = join(f.root, 'release-link.json');
  await symlink(f.manifestPath, linkPath);
  await assert.rejects(readPublishedElectronSiteRelease({ ...f.options, manifestPath: linkPath,
    verifyPublishedInstaller: async () => assert.fail('symlink must fail before fetch') }), /exact reviewed/u);
});
test('Electron intake binds the reviewed identity and the target bytes before exposing the exact download',async t=>{
  const f=await fixture(t), calls=[];const release=await readElectronSitePublication({...f.options,verifyPublishedInstaller:async value=>{calls.push(value);return {bytes:value.expectedBytes,sha256:value.expectedSha256};}});
  assert.equal(calls.length,1);assert.equal(release.downloads.length,1);
  for (const call of calls) assert.match(call.installerUrl,/^https:\/\/github.com\/adamallcock\/tibotattle\/releases\/download\/v0\.1\.20\/TiboTattle-0\.1\.20-Windows-x64\.exe$/u);
  await assert.rejects(readElectronSitePublication({...f.options,approvedPlanSha256:'0'.repeat(64)}),/exact reviewed/u);
  await writeFile(join(f.root,f.plan.targets[0].artifacts[0].localPath),'modified');
  await assert.rejects(readElectronSitePublication({...f.options,verifyPublishedInstaller:async()=>assert.fail('must not GET tampered artifact')}),/exact reviewed/u);
});
test('Electron intake refuses foreign feed and symlink artifacts before a download claim',async t=>{
  const f=await fixture(t);f.plan.targets[0].feedURL='https://other.tibotattle.com';await writeFile(f.planPath,JSON.stringify(f.plan));
  await assert.rejects(readElectronSitePublication({...f.options,approvedPlanSha256:identityDigest(f.plan)}),/exact reviewed/u);
  const g=await fixture(t);const path=join(g.root,g.plan.targets[0].artifacts[0].localPath);await rm(path);await symlink(g.planPath,path);
  await assert.rejects(readElectronSitePublication({...g.options,verifyPublishedInstaller:async()=>{}}),/exact reviewed/u);
});
test('a macOS or Linux artifact in the reviewed plan is refused, not rendered',async t=>{
  const f=await fixture(t);
  f.plan.targets[0].target='darwin-arm64';await writeFile(f.planPath,JSON.stringify(f.plan));
  await assert.rejects(readElectronSitePublication({...f.options,approvedPlanSha256:identityDigest(f.plan),verifyPublishedInstaller:async()=>{}}),/exact reviewed/u);
});
test('actual public generator renders the Windows installer, keeps automatic replacement and updates docs without dashboard assets',async t=>{
  const f=await fixture(t);const social=join(f.root,'social.png');await writeFile(social,await readFile(new URL('../apps/web/public/tibotattle-icon.png',import.meta.url)));
  const output=join(f.root,'output'); // Root contains output, but output never contains any intake file.
  const args={output,siteUrl:'https://tibotattle.com/',releaseNotesUrl:'https://github.com/adamallcock/tibotattle/releases/tag/v0.1.20',privacyUrl:'https://tibotattle.com/privacy',securityUrl:'https://tibotattle.com/docs',supportUrl:'https://github.com/adamallcock/tibotattle/issues',socialImage:social,electronPublicationPlan:f.planPath,electronPublicationRoot:f.root,electronApprovedPlanSha256:f.options.approvedPlanSha256};
  let calls=0;await buildPublicReleaseSite(args,{verifyPublishedInstaller:async value=>{calls++;return {bytes:value.expectedBytes,sha256:value.expectedSha256,published:false};}});
  assert.equal(calls,1);const html=await readFile(join(output,'index.html'),'utf8');
  assert.equal((html.match(/data-electron-download=/gu)||[]).length,1);
  assert.doesNotMatch(html,/electron-handover|Updating an existing Mac installation|Download size| bytes<\/p>/u);
  assert.equal((html.match(/class="installer-checksum-copy electron-checksum-copy"/gu)||[]).length,1);
  assert.equal((html.match(/href="https:\/\/github.com\/adamallcock\/tibotattle\/releases\/download\/v0\.1\.20\//gu)||[]).length,1);
  assert.doesNotMatch(html,/href="https:\/\/updates\.tibotattle\.com\/electron/);
  assert.doesNotMatch(html,/native-app|Keep the old app|install native 0\.1\.18/u);
  assert.equal((html.match(/private desktop app for Windows/gu)||[]).length,3);
  assert.doesNotMatch(html,/macOS|Mac app|Homebrew|brew install|\.dmg\b|AppImage|apple\.svg|data-platform-panel="(?:macos|linux)"|platform-panel-(?:macos|linux)/u);
  assert.match(html,/<meta property="og:image:width" content="1024">/u);
  assert.match(html,/<meta property="og:image:height" content="1024">/u);
  assert.match(html,/<meta name="twitter:card" content="summary">/u);
  assert.match(html,/<meta property="og:image:alt" content="TiboTattle logo">/u);assert.doesNotMatch(html,/Your existing data and credentials are preserved/u);
  assert.doesNotMatch(html,/not available yet|src="\.\/app.js"/u);
  assert.equal(await readFile(join(output,'community.html'),'utf8'),html);
  const privacy=await readFile(join(output,'privacy.html'),'utf8');assert.match(privacy,/<body[^>]*data-i18n-root/u);assert.match(privacy,/<script type="module" src="\.\/localization\.js"><\/script>/u);assert.match(privacy,/data-i18n="community\.privacy\.sample"/u);
  const docs=await readFile(join(output,'docs.html'),'utf8');assert.match(docs,/<body[^>]*data-i18n-root/u);assert.match(docs,/<script type="module" src="\.\/localization\.js"><\/script>/u);assert.match(docs,/Electron downloads are available for Windows 10 or later on x64/u);assert.match(docs,/automatically transfers retained history and settings/u);assert.doesNotMatch(docs,/Signed releases use the Sparkle feed|local-first Mac app|native Mac version|macOS|Linux/u);
  const manifest=JSON.parse(await readFile(join(output,'release-site-manifest.json'),'utf8'));assert.equal(manifest.electronRelease.downloads.length,1);assert.equal(manifest.electronRelease.publishedInstallersVerified,false);assert.doesNotMatch(JSON.stringify(manifest.electronRelease.verificationScope),/published-installer/u);assert.equal(manifest.installer,undefined);
});
test('CLI accepts only explicit complete Electron intake flags',()=>{
  const args=parseArgs(['--electron-publication-plan','/plan.json','--electron-publication-root','/root','--electron-approved-plan-sha256','a'.repeat(64)]);
  assert.equal(args.electronPublicationPlan,'/plan.json');assert.equal(args.electronApprovedPlanSha256,'a'.repeat(64));
});

test('automatic replacement copy cannot be built against the legacy 0.1.19 release', async t => {
  const f = await fixture(t); f.plan.version = '0.1.19';
  await writeFile(f.planPath, JSON.stringify(f.plan));
  await assert.rejects(readElectronSitePublication({...f.options, approvedPlanSha256: identityDigest(f.plan), verifyPublishedInstaller: async () => assert.fail('legacy release must fail before any download')}), /exact reviewed/u);
});

test('Electron Privacy localization preserves all source content and uses only the existing local module', async () => {
  const source = await readFile(new URL('../apps/web/public/privacy.html', import.meta.url), 'utf8');
  const rendered = renderElectronSiteDocumentation(source);
  assert.match(rendered, /<body[^>]*data-i18n-root/u);
  assert.equal((rendered.match(/<script\b/gu) ?? []).length, 1);
  assert.match(rendered, /<script type="module" src="\.\/localization\.js"><\/script>/u);
  assert.equal(rendered.replace(' data-i18n-root', '').replace('<script type="module" src="./localization.js"></script>\n', ''), source,
    'privacy sections and content must not receive the Docs-specific rewrites');
  for (const key of ['sample', 'smallSample', 'publicationRules']) assert.ok(rendered.includes(`data-i18n="community.privacy.${key}"`));
  assert.equal(renderElectronSiteDocumentation('<body><p>Unrelated resource</p></body>'), '<body><p>Unrelated resource</p></body>');
});

test('Electron renderer replaces only the Windows panel and refuses a retired macOS or Linux panel', async () => {
  const source = await readFile(new URL('../apps/web/public/community.html', import.meta.url), 'utf8');
  const release = { version: '0.1.20', publishedInstallersVerified: false, downloads: [{ target: WINDOWS_TARGET,
    url: `https://github.com/adamallcock/tibotattle/releases/download/v0.1.20/${WINDOWS_NAME('0.1.20')}`,
    bytes: 1, sha256: 'a'.repeat(64) }] };
  const html = renderElectronSiteDownloads(source, release);
  assert.match(html, /<section\b[^>]*\bid="platform-panel-windows"[^>]*\baria-label="Windows download"/u);
  assert.equal((html.match(/<section\b/gu) ?? []).length, (source.match(/<section\b/gu) ?? []).length);
  assert.match(html, /data-i18n="electron\.site\.download\.windows"/u);
  assert.throws(() => renderElectronSiteDownloads(source.replace('</head>',
    '<section id="platform-panel-macos"></section></head>'), release), /exact reviewed/u);
});

async function electronSiteArgs(f, socialBytes) {
  const social = join(f.root, 'social.png');
  await writeFile(social, socialBytes);
  return { output: join(f.root, 'output'), siteUrl: 'https://tibotattle.com/',
    releaseNotesUrl: 'https://github.com/adamallcock/tibotattle/releases/tag/v0.1.20',
    privacyUrl: 'https://tibotattle.com/privacy', securityUrl: 'https://tibotattle.com/docs',
    supportUrl: 'https://github.com/adamallcock/tibotattle/issues', socialImage: social,
    electronPublicationPlan: f.planPath, electronPublicationRoot: f.root,
    electronApprovedPlanSha256: f.options.approvedPlanSha256 };
}

test('Electron mode keeps the large card for a rendered 1200x630 homepage preview', async t => {
  const f = await fixture(t);
  const args = await electronSiteArgs(f, grayscalePng(1200, 630));
  await buildPublicReleaseSite(args, { verifyPublishedInstaller: async value =>
    ({ bytes: value.expectedBytes, sha256: value.expectedSha256, published: false }) });
  const html = await readFile(join(args.output, 'index.html'), 'utf8');
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/u);
  assert.match(html, /<meta property="og:image:width" content="1200">/u);
  assert.match(html, /<meta property="og:image:height" content="630">/u);
  assert.doesNotMatch(html, /content="1024"|content="summary">/u);
  // The rendered card pictures this page, so it keeps the source-owned alt text.
  assert.match(html, new RegExp(`<meta property="og:image:alt" content="${SOURCE_SOCIAL_ALT}">`, 'u'));
  assert.doesNotMatch(html, /og:image:alt" content="TiboTattle logo"/u);
  assert.equal((html.match(/data-electron-download=/gu) || []).length, 1);
  assert.deepEqual(await readFile(join(args.output, 'social-preview.png')), grayscalePng(1200, 630));
  const manifest = JSON.parse(await readFile(join(args.output, 'release-site-manifest.json'), 'utf8'));
  assert.equal(manifest.site.socialPreview.width, 1200);
  assert.equal(manifest.site.socialPreview.height, 630);
});

test('Electron mode refuses any social image that is neither the brand icon nor a rendered card', async t => {
  const f = await fixture(t);
  const verifyPublishedInstaller = async value =>
    ({ bytes: value.expectedBytes, sha256: value.expectedSha256, published: false });
  for (const bytes of [grayscalePng(1200, 631), grayscalePng(1024, 1023), grayscalePng(1201, 630)]) {
    await assert.rejects(buildPublicReleaseSite(await electronSiteArgs(f, bytes), { verifyPublishedInstaller }),
      /Electron social preview must be the 1024x1024 brand icon or a rendered 1200x630 card/u);
  }
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x20), Buffer.from([0xff, 0xd9])]);
  await assert.rejects(buildPublicReleaseSite(await electronSiteArgs(f, jpeg), { verifyPublishedInstaller }),
    /Social preview must be a complete PNG file/u);
  // A square image that is not the reviewed icon still fails the byte pin.
  await assert.rejects(buildPublicReleaseSite(await electronSiteArgs(f, grayscalePng(1024, 1024)), { verifyPublishedInstaller }),
    /Electron social preview must match the reviewed public brand icon/u);
});

test('release-site build rejects a source mutation after Electron provenance capture', async t => {
  const f = await fixture(t);
  const sourceRoot = await mkdtemp(join(tmpdir(), 'electron-site-source-'));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  const source = join(sourceRoot, 'public');
  await cp(new URL('../apps/web/public/', import.meta.url), source, { recursive: true });
  const args = { ...(await electronSiteArgs(f, grayscalePng(1200, 630))), source };
  await assert.rejects(buildPublicReleaseSite(args, { verifyPublishedInstaller: async value => {
    await writeFile(join(source, 'community.js'), 'export const changedAfterCapture = true;\n');
    return { bytes: value.expectedBytes, sha256: value.expectedSha256, published: false };
  } }), /source changed after provenance capture/u);
  await assert.rejects(readFile(join(args.output, 'release-site-manifest.json')), { code: 'ENOENT' });
});
