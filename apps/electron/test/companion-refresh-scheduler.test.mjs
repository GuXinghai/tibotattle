import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { createCompanionSupervisor } from "../companion-supervisor.js";

test("owned child receives initial cadence and live disabled/reenabled values over fixed IPC", async t => {
  const moduleUrl = new URL("../../local/overview-refresh-scheduler.js", import.meta.url).href;
  const source = `
    const {attachOverviewRefreshIntervalChannel} = await import(${JSON.stringify(moduleUrl)});
    let seconds = Number(process.env.USAGE_MONITOR_REFRESH_INTERVAL_SECONDS);
    attachOverviewRefreshIntervalChannel({channel:process,scheduler:{setIntervalSeconds(value){seconds=value;}}});
    process.on('message', message => {if(message?.type==='test.status') process.send({seconds});});
    process.stdout.write('USAGE_MONITOR_READY http://127.0.0.1:4546/\\n');
  `;
  let child, selected;
  const supervisor = createCompanionSupervisor({ command: process.execPath,
    args: ["--input-type=module", "--eval", source], environment: {},
    spawnChild(command, args, options) { selected = options; child = spawn(command, args, options); return child; },
  });
  t.after(async () => { await supervisor.stop().catch(() => {}); });
  assert.equal(supervisor.setRefreshInterval(420), false);
  await supervisor.start();
  assert.equal(selected.env.USAGE_MONITOR_REFRESH_INTERVAL_SECONDS, "420");
  assert.deepEqual(selected.stdio, ["ignore", "pipe", "pipe", "ipc"]);
  const status = async () => { const next = once(child, "message"); child.send({ type: "test.status" }); return (await next)[0]; };
  assert.deepEqual(await status(), { seconds: 420 });
  assert.equal(await supervisor.setRefreshInterval(-1), true);
  assert.deepEqual(await status(), { seconds: -1 });
  assert.equal(await supervisor.setRefreshInterval(60), true);
  assert.deepEqual(await status(), { seconds: 60 });
  for (const value of [0, 61, "60", Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => supervisor.setRefreshInterval(value), /refresh interval is invalid/u);
  }
  await supervisor.stop();
  await supervisor.start();
  assert.equal(selected.env.USAGE_MONITOR_REFRESH_INTERVAL_SECONDS, "60");
  assert.deepEqual(await status(), { seconds: 60 });
});
