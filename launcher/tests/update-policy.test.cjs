const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const policy = require("../electron/update-policy.json");
const { createUpdateController } = require("../electron/update.cjs");

const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");

test("this fork's builds do not offer upstream releases, and main.cjs hands the policy to the updater", () => {
  assert.equal(policy.offerUpstreamReleases, false);
  assert.match(main, /require\("\.\/update-policy\.json"\)/);
  assert.match(main, /packaged: app\.isPackaged && !IS_DEV_PROFILE && updatePolicy\.offerUpstreamReleases === true/);
});

test("a disabled updater never fetches a release and publishes no available update", async () => {
  let fetched = 0;
  const published = [];
  const controller = createUpdateController({
    currentVersion: "6.1.14",
    platform: "win32",
    arch: "x64",
    packaged: false,
    executablePath: "C:/app.exe",
    runtimeExecutable: "C:/bun.exe",
    logsDirectory: "C:/logs",
    publish: (state) => published.push(state.status),
    dependencies: { fetchRelease: async () => { fetched += 1; return { tag_name: "v6.1.15" }; } },
  });
  assert.deepEqual(await controller.checkOnce(), { status: "disabled" });
  assert.equal(fetched, 0);
  assert.equal(published.includes("available"), false);
});
