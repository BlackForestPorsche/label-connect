/**
 * Minimal WebDriver client for the Firefox Desk e2e: geckodriver over HTTP, no Selenium.
 *
 * Loads extension/firefox as a temporary add-on in a throwaway profile and gives the tests
 * a tab on a Desk page (popup.html), where `browser.*` and the background page are reachable.
 * WebDriver may not navigate to moz-extension:// URLs, so that tab is opened from the
 * browser-chrome context (geckodriver --allow-system-access).
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const ADDON_ID = "black-forest-desk@blackforestautomotive.com";
/** Pinned so the moz-extension:// origin is known before the add-on loads. */
export const ADDON_UUID = "5b1e7c1e-6f0a-4c56-9c53-0d2f1a7e9b11";
export const EXT_ORIGIN = `moz-extension://${ADDON_UUID}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function which(name) {
  try {
    return execFileSync("which", [name], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export function findFirefox() {
  if (process.env.DESK_FIREFOX) return process.env.DESK_FIREFOX;
  return which("firefox") || which("firefox-esr");
}

export function findGeckodriver() {
  if (process.env.DESK_GECKODRIVER) return process.env.DESK_GECKODRIVER;
  if (process.env.GECKOWEBDRIVER) {
    const bundled = path.join(process.env.GECKOWEBDRIVER, "geckodriver");
    if (fs.existsSync(bundled)) return bundled;
  }
  return which("geckodriver");
}

export async function startFirefox({ extension, proxyPort, prefs = {}, port = 4477, headless = true } = {}) {
  const binary = findFirefox();
  const gecko = findGeckodriver();
  if (!binary || !gecko) throw new Error("Firefox or geckodriver not found");
  const proc = spawn(gecko, ["--port", String(port), "--allow-system-access"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(`${base}/status`);
      if (r.ok) break;
    } catch {
      // geckodriver still starting
    }
    await sleep(100);
  }
  const call = async (method, route, body) => {
    const r = await fetch(`${base}${route}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) {
      const value = data && data.value;
      throw new Error(`${method} ${route}: ${String((value && value.message) || JSON.stringify(value)).slice(0, 500)}`);
    }
    return data.value;
  };
  const proxyPrefs = proxyPort
    ? {
        "network.proxy.type": 1,
        "network.proxy.http": "127.0.0.1",
        "network.proxy.http_port": proxyPort,
        "network.proxy.ssl": "127.0.0.1",
        "network.proxy.ssl_port": proxyPort,
        "network.proxy.no_proxies_on": "",
      }
    : {};
  let session;
  try {
    session = await call("POST", "/session", {
      capabilities: {
        alwaysMatch: {
          acceptInsecureCerts: true,
          "moz:firefoxOptions": {
            binary,
            args: headless ? ["-headless"] : [],
            prefs: {
              "extensions.webextensions.uuids": JSON.stringify({ [ADDON_ID]: ADDON_UUID }),
              "xpinstall.signatures.required": false,
              "browser.download.folderList": 2,
              "browser.download.dir": "/tmp",
              "browser.download.useDownloadDir": true,
              ...proxyPrefs,
              ...prefs,
            },
          },
        },
      },
    });
  } catch (error) {
    proc.kill();
    throw new Error(`${error.message}\n${log.slice(-1500)}`);
  }
  const sid = session.sessionId;
  const s = (method, route, body) => call(method, `/session/${sid}${route}`, body);

  const api = {
    version: session.capabilities.browserVersion,
    log: () => log,
    go: (url) => s("POST", "/url", { url }),
    url: () => s("GET", "/url"),
    handles: () => s("GET", "/window/handles"),
    handle: () => s("GET", "/window"),
    switchTo: (handle) => s("POST", "/window", { handle }),
    closeTab: () => s("DELETE", "/window"),
    setRect: (rect) => s("POST", "/window/rect", rect),
    /** Run async JS in the current tab; `arguments` are the args. Returns its value. */
    async exec(script, args = []) {
      const result = await s("POST", "/execute/async", {
        script: `const done = arguments[arguments.length - 1];
          (async () => { ${script} })().then(
            (v) => done({ ok: true, v: v === undefined ? null : v }),
            (e) => done({ ok: false, e: String((e && e.stack) || e) }),
          );`,
        args,
      });
      if (!result || !result.ok) throw new Error((result && result.e) || "script failed");
      return result.v;
    },
    /** Run privileged JS in the browser-chrome context. */
    async chrome(script, args = []) {
      await s("POST", "/moz/context", { context: "chrome" });
      try {
        return await api.exec(script, args);
      } finally {
        await s("POST", "/moz/context", { context: "content" });
      }
    },
    async newTab(url) {
      const tab = await s("POST", "/window/new", { type: "tab" });
      await s("POST", "/window", { handle: tab.handle });
      if (url) await api.go(url);
      return tab.handle;
    },
    /** Open a Desk page (popup.html by default) in a new tab and switch to it. */
    async openExtensionPage(page = "popup.html") {
      const before = await api.handles();
      await api.chrome(
        `const win = Services.wm.getMostRecentWindow("navigator:browser");
         win.gBrowser.selectedTab = win.gBrowser.addTab(arguments[0], {
           triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
         });
         return true;`,
        [`${EXT_ORIGIN}/${page}`],
      );
      for (let i = 0; i < 100; i += 1) {
        const handle = (await api.handles()).find((h) => !before.includes(h));
        if (handle) {
          await api.switchTo(handle);
          for (let j = 0; j < 100; j += 1) {
            if (String(await api.url()).startsWith(EXT_ORIGIN)) {
              await api.exec(
                `while (document.readyState !== "complete") await new Promise((r) => setTimeout(r, 25));`,
              );
              return handle;
            }
            await sleep(50);
          }
          return handle;
        }
        await sleep(50);
      }
      throw new Error("Desk page did not open");
    },
    /** Type into an element like a person would. "\uE007" is Enter. */
    async type(selector, text) {
      const el = await s("POST", "/element", { using: "css selector", value: selector });
      await s("POST", `/element/${Object.values(el)[0]}/value`, { text });
    },
    async screenshot(file, selector) {
      let b64;
      if (selector) {
        const el = await s("POST", "/element", { using: "css selector", value: selector });
        const id = Object.values(el)[0];
        b64 = await s("GET", `/element/${id}/screenshot`);
      } else {
        b64 = await s("GET", "/screenshot");
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(b64, "base64"));
    },
    async quit() {
      try {
        await s("DELETE", "");
      } catch {
        // already gone
      }
      proc.kill();
    },
  };
  if (extension) await s("POST", "/moz/addon/install", { path: extension, temporary: true });
  return api;
}
