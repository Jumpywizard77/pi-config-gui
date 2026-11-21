// Runtime smoke test against the BUILT cli: boots `dist/cli.js --no-open
// --port 0` twice against a throwaway agent dir holding a generated
// models.json — once with an ABSOLUTE `--agent-dir`, once with a RELATIVE
// one (the CLI must resolve it against the process cwd before handing it
// down) — then checks /api/state discovery, /api/config text echo, the
// built UI on /, and the forged-Host 403. Used by the Node-20 CI job (the
// runtime floor: the dev toolchain needs newer Node, shipped code must run
// here) and handy locally after `npm run build`. Exits non-zero on any
// failed expectation.
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function assert(condition, message) {
  if (!condition) {
    throw new Error(`smoke failed: ${message}`);
  }
}

// A throwaway agent dir: `models` is discovered with exists:true, `auth`
// with exists:false (managed docs are always listed), and the config route
// must echo this exact text.
const MODELS_TEXT =
  '{\n  "providers": {\n    "smoke": { "baseUrl": "http://smoke.invalid/v1" }\n  }\n}\n';
const agentDir = mkdtempSync(path.join(tmpdir(), "pi-smoke-agent-"));
writeFileSync(path.join(agentDir, "models.json"), MODELS_TEXT);

const children = [];
const watchdog = setTimeout(() => {
  for (const child of children) child.kill();
  console.error("smoke failed: server did not report a bound port within 60s");
  process.exit(1);
}, 60_000);

/** Boot dist/cli.js with extra args; resolves once it prints its bound URL. */
function bootCli(cliArgs, spawnOptions = {}) {
  const child = spawn(process.execPath, [cliPath, "--no-open", "--port", "0", ...cliArgs], {
    stdio: ["ignore", "pipe", "pipe"],
    ...spawnOptions,
  });
  children.push(child);
  let out = "";
  const url = new Promise((resolveUrl, rejectUrl) => {
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
      // The trailing slash stays OUTSIDE the capture: `${url}/api/...` must
      // not become `//api/...` (which static SPA fallback would swallow).
      const match = out.match(/running at (http:\/\/127\.0\.0\.1:\d+)\//);
      if (match) resolveUrl({ url: match[1], out });
    });
    child.stderr.on("data", (chunk) => {
      out += String(chunk);
    });
    child.on("error", rejectUrl);
    child.on("exit", (code) => rejectUrl(new Error(`server exited early (code ${code}): ${out}`)));
  });
  return url;
}

/** node:http (not fetch): undici may rewrite a caller-set Host, vacuous check. */
function requestWithForgedHost(url) {
  return new Promise((resolveStatus, rejectStatus) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: new URL(url).port,
        path: "/api/state",
        // Without setHost:false Node overwrites the Host header itself.
        setHost: false,
        headers: { Host: "example.com" },
      },
      (response) => {
        response.resume();
        resolveStatus(response.statusCode ?? 0);
      },
    );
    request.on("error", rejectStatus);
    request.end();
  });
}

try {
  // --- Boot 1: absolute --agent-dir ---------------------------------------
  const { url, out } = await bootCli(["--agent-dir", agentDir]);
  assert(!out.includes("?folder="), `boot URL carries folder machinery: ${out.trim()}`);

  const state = await fetch(`${url}/api/state`);
  assert(state.status === 200, `/api/state returned ${state.status}`);
  const body = await state.json(); // throws unless the body is JSON
  assert(Array.isArray(body.docs), "/api/state JSON has no `docs` array");
  assert(
    path.resolve(body.agentDir) === agentDir,
    `/api/state agentDir ${body.agentDir} is not the --agent-dir ${agentDir}`,
  );
  const models = body.docs.find((doc) => doc.id === "models");
  assert(models !== undefined, "/api/state lists no `models` doc");
  assert(models.exists === true, "`models` doc does not have exists:true");
  assert(
    body.docs.some((doc) => doc.id === "auth"),
    "/api/state lists no `auth` doc",
  );

  const config = await fetch(`${url}/api/config?doc=models`);
  assert(config.status === 200, `/api/config?doc=models returned ${config.status}`);
  const configBody = await config.json();
  assert(
    configBody.text === MODELS_TEXT,
    `/api/config did not echo the models.json text (got ${JSON.stringify(configBody.text)})`,
  );
  assert(configBody.exists === true, "/api/config reports exists:false for a file we wrote");

  const page = await fetch(`${url}/`);
  assert(page.status === 200, `/ returned ${page.status}`);
  const html = await page.text();
  assert(/<html/i.test(html), "/ did not serve an HTML document");

  // Loopback-only contract: the server must not answer a foreign Host header
  // (DNS-rebinding guard).
  const forgedStatus = await requestWithForgedHost(url);
  assert(forgedStatus === 403, `forged Host header got ${forgedStatus}, expected 403`);

  // --- Boot 2: RELATIVE --agent-dir (cli.ts must resolve it against cwd) ---
  const relativeBoot = await bootCli(["--agent-dir", path.basename(agentDir)], {
    cwd: path.dirname(agentDir),
  });
  const relState = await fetch(`${relativeBoot.url}/api/state`);
  assert(relState.status === 200, `/api/state (relative boot) returned ${relState.status}`);
  const relBody = await relState.json();
  assert(
    path.resolve(relBody.agentDir) === agentDir,
    `relative --agent-dir resolved to ${relBody.agentDir}, expected ${agentDir}`,
  );
  assert(
    relBody.docs.some((doc) => doc.id === "models" && doc.exists === true),
    "relative boot does not discover the models.json",
  );

  console.log(`smoke ok: ${url} served state/config/index.html, forged Host refused,`);
  console.log("smoke ok: relative --agent-dir resolved against the process cwd");
} finally {
  clearTimeout(watchdog);
  for (const child of children) child.kill();
  rmSync(agentDir, { recursive: true, force: true, maxRetries: 5 });
}
