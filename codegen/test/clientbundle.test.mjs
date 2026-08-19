import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateProject } from "../src/project.mjs";
import {
  assertRegistryIdsAgree,
  clientBundleName,
  clientBundleURL,
  extractRegistryIds,
  hasClientCode,
} from "../src/clientbundle.mjs";

/**
 * The client-bundle pipeline (FR12 wave 1, Phase C -- the browser half).
 *
 * The end-to-end cases run the REAL pipeline over the quickstart fixture --
 * real @marko/compiler in both `html` and `dom` mode, real Bun.build -- rather
 * than asserting on a mocked bundler, because every property worth testing
 * here is a property of what the real compiler emits: which pages have client
 * code, and whether the registry ids in the two compiles agree.
 */
const FIXTURE =
  "/private/tmp/claude-501/-Users-svallory-work-go-marko/6b33a62a-f0c0-4f0a-af15-a7bea5f57259/scratchpad/qsfixture";

let root;
let uiDir;
let result;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "marko-go-client-"));
  fs.cpSync(path.join(FIXTURE, "ui"), path.join(root, "ui"), { recursive: true });
  fs.writeFileSync(path.join(root, "go.mod"), "module myapp\n\ngo 1.24\n");
  uiDir = path.join(root, "ui");
  result = await generateProject(uiDir);
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("client bundles", () => {
  test("only a page with client code gets one", () => {
    // reactive.marko has `<let>` + onClick handlers; landing and counter are
    // server-rendered only. Shipping a bundle for those would be dead weight
    // on every request, and one for a TAG would be a bundle nothing loads.
    const names = result.jsAssets.map((a) => path.basename(a.outPath)).sort();
    expect(names).toEqual(["pages-reactive.js"]);
  });

  test("the asset carries everything a consumer needs", () => {
    const [asset] = result.jsAssets;
    expect(asset.kind).toBe("client-bundle");
    expect(asset.markoPath).toBe(path.join(uiDir, "pages", "reactive.marko"));
    expect(asset.url).toBe("/.marko-go/client/pages-reactive.js");
    expect(asset.code.length).toBeGreaterThan(0);
  });

  test("it is written to disk under the default client dir", () => {
    const [asset] = result.jsAssets;
    expect(asset.outPath).toBe(
      path.join(uiDir, ".marko-go", "client", "pages-reactive.js"),
    );
    expect(fs.readFileSync(asset.outPath, "utf8")).toBe(asset.code);
  });

  test("the page's Go names its bundle; other templates name none", () => {
    const go = (rel) =>
      result.goFiles.find((f) => f.outPath === path.join(uiDir, rel)).code;
    expect(go("pages/reactive.marko.go")).toContain(
      'w.ClientBundle("/.marko-go/client/pages-reactive.js")',
    );
    for (const rel of [
      "pages/landing.marko.go",
      "pages/counter.marko.go",
      "tags/elements/ui-button.marko.go",
    ]) {
      expect(go(rel)).not.toContain("w.ClientBundle(");
    }
  });

  test("every AddScript id the server can write is registered by the bundle", () => {
    // THE invariant, asserted on the real artifacts end to end. Ids hash the
    // template's absolute path, so a mismatch yields a page that renders
    // perfectly, ships a bundle, throws no error, and is completely inert.
    //
    // This caught a real one: bundlers resolve imports through realpath, and
    // on macOS `/var` is a symlink to `/private/var`, so a temp-directory
    // fixture gave the bundler a different spelling of the same files than
    // generateProject held -- two id sets, dead page. Fixed by hashing a
    // canonical path on both sides (clientbundle.mjs's canonicalPath), and
    // this test is what keeps it fixed.
    //
    // Every template here is reachable from /reactive (the page's own `<let>`
    // effect, plus ui-button's two branches via the navbar), so all of them
    // must be in the one bundle.
    const [asset] = result.jsAssets;
    const scriptIds = new Set(
      result.goFiles.flatMap((f) =>
        [...f.code.matchAll(/w\.AddScript\("([^"]+)"/g)].map((m) => m[1]),
      ),
    );
    expect(scriptIds.size).toBeGreaterThan(0);
    for (const id of scriptIds) expect(asset.code).toContain(id);
  });

  test("--no-client skips bundles AND the script tag", () => {
    // Half of this off would be worse than either: a script tag with no
    // bundle 404s, and a bundle no page loads is invisible waste.
    return generateProject(uiDir, { write: false, client: false }).then((r) => {
      expect(r.jsAssets).toEqual([]);
      for (const f of r.goFiles) expect(f.code).not.toContain("w.ClientBundle(");
    });
  });

  test("--client-url changes the URL without moving the files", async () => {
    const r = await generateProject(uiDir, {
      write: false,
      clientURL: "/static/js/",
    });
    const [asset] = r.jsAssets;
    expect(asset.url).toBe("/static/js/pages-reactive.js");
    const page = r.goFiles.find((f) => f.outPath.endsWith("reactive.marko.go"));
    expect(page.code).toContain('w.ClientBundle("/static/js/pages-reactive.js")');
  });

  test("--client-dir moves the files without changing the URL", async () => {
    const outDir = path.join(root, "public", "js");
    const r = await generateProject(uiDir, { clientDir: outDir });
    const [asset] = r.jsAssets;
    expect(asset.outPath).toBe(path.join(outDir, "pages-reactive.js"));
    expect(fs.existsSync(asset.outPath)).toBe(true);
    expect(asset.url).toBe("/.marko-go/client/pages-reactive.js");
  });
});

describe("client-bundle helpers", () => {
  test("extractRegistryIds finds ids in both compile targets' spellings", () => {
    // dom: `_script("id", fn)`; html: `_script(scopeId, "id")`.
    expect(extractRegistryIds('_script("aBc123", $scope => {})')).toEqual(["aBc123"]);
    expect(extractRegistryIds('_script($scope1_id, "aBc123");')).toEqual(["aBc123"]);
    expect(extractRegistryIds('_content("Xy1", () => {}, 0)')).toEqual(["Xy1"]);
    expect(extractRegistryIds("no ids here")).toEqual([]);
  });

  test("hasClientCode keys off a dom _script registration", () => {
    expect(hasClientCode('const s = _script("b0Wj1Am", $scope => {});')).toBe(true);
    // A page with no reactivity still has a template, walks and a $setup --
    // just nothing registered for init() to run.
    expect(hasClientCode('export const $template = "<div></div>";')).toBe(false);
  });

  test("assertRegistryIdsAgree fails loudly on a server id the client lacks", () => {
    expect(() =>
      assertRegistryIdsAgree("/x/y.marko", '_script($s, "serverOnly")', '_script("other", f)'),
    ).toThrow(/serverOnly/);
    // The reverse is fine: the dom module can carry ids for an untaken branch.
    expect(() =>
      assertRegistryIdsAgree("/x/y.marko", '_script($s, "a")', '_script("a", f);_script("b", f)'),
    ).not.toThrow();
  });

  test("bundle names flatten the path, so two pages cannot collide", () => {
    expect(clientBundleName("/p/ui", "/p/ui/pages/reactive.marko")).toBe("pages-reactive");
    expect(clientBundleName("/p/ui", "/p/ui/admin/pages/reactive.marko")).toBe(
      "admin-pages-reactive",
    );
  });

  test("clientBundleURL tolerates a base with or without a trailing slash", () => {
    expect(clientBundleURL("/static/js/", "a")).toBe("/static/js/a.js");
    expect(clientBundleURL("/static/js", "a")).toBe("/static/js/a.js");
  });
});
