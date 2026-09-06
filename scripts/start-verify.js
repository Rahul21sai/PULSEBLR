// Start a production server that shares NOTHING with the dev server another session is holding.
//
// WHY THIS FILE EXISTS RATHER THAN AN INLINE COMMAND. Two constraints collide:
//
//   1. `next start` resolves `distDir` from `next.config.ts` at boot, so `PULSEBLR_DIST_DIR` has
//      to be set in the SERVER's environment, not just for the build. There is no CLI flag.
//   2. Setting it inline is not portable. `VAR=x cmd` is POSIX-only; `cmd /c "set VAR=x && …"` is
//      Windows-only; and `"runtimeExecutable": "bash"` in a launch config resolves to WSL bash on
//      a Windows machine with WSL present, which fails with "no installed distributions" rather
//      than falling back to Git Bash. That was measured, not guessed.
//
// So the environment is set in Node, where it is just an assignment, and the same command works
// on every platform. Plain JS for the same reason `copy-wasm.js` and `generate-icons.js` are:
// nothing here should need `tsx` to run.
//
// USAGE (`.claude/launch.json` is gitignored, so these are the commands that actually travel):
//
//   Dev server, port 3201, own build dir — use this for anything behind auth:
//     node scripts/start-verify.js --dev
//
//   Production server, port 3200 — the exact artefact that deploys:
//     PULSEBLR_DIST_DIR=.next-verify npm run build
//     node scripts/start-verify.js
//
//   Override either: --port 3300, or PULSEBLR_DIST_DIR=.next-whatever
//
// See the `distDir` note in next.config.ts for why building into the shared `.next` while a dev
// server is using it is the thing being avoided — it swaps the route manifest underneath that
// server and produces phantom 404s on routes that exist.

// TWO MODES, and which one you want depends on whether you need to SIGN IN.
//
//   (default)  `next start` — serves a production build. This is the exact artefact that
//              deploys, so it is the right mode for checking build output, bundle behaviour and
//              the service worker (`app/layout.tsx` unregisters the SW in development, so
//              offline behaviour cannot be verified any other way).
//
//   --dev      `next dev` — a second dev server on its own port AND its own distDir. Needed for
//              anything behind auth: `next start` runs with NODE_ENV=production, and
//              `lib/dev-login.ts` refuses to activate there (correctly — that guard is what
//              stops DEV_LOGIN ever working on Vercel), while Google OAuth is pinned to port
//              3000. So in production mode every protected page just 307s to /login and there is
//              no way in. Two `next dev` processes cannot share one `.next`; with distinct
//              distDirs they coexist happily.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const dev = process.argv.includes('--dev');
const distDir = process.env.PULSEBLR_DIST_DIR || (dev ? '.next-verify-dev' : '.next-verify');

// `--port N` wins over PORT, so a launch entry's declared port and the port actually bound cannot
// drift apart — the preview tooling watches the declared one and would wait forever on a mismatch.
const portFlag = process.argv.indexOf('--port');
const port =
  portFlag !== -1 && process.argv[portFlag + 1]
    ? process.argv[portFlag + 1]
    : process.env.PORT || (dev ? '3201' : '3200');

if (!dev && !fs.existsSync(path.join(process.cwd(), distDir, 'BUILD_ID'))) {
  console.error(
    `No build found in ${distDir}/. Run this first:\n\n  PULSEBLR_DIST_DIR=${distDir} npm run build\n`
  );
  process.exit(1);
}

console.log(`${dev ? 'Dev server' : 'Serving ' + distDir} on http://localhost:${port}`);

const child = spawn('npx', ['next', dev ? 'dev' : 'start', '--port', port], {
  // `shell: true` because `npx` is a .cmd shim on Windows and is not directly executable.
  shell: true,
  stdio: 'inherit',
  env: { ...process.env, PULSEBLR_DIST_DIR: distDir },
});

child.on('exit', code => process.exit(code ?? 0));
