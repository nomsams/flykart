import { describe, expect, it } from "vitest";
import { SpikingNetwork } from "../core";
import { browseRepository, defaultRepo, fetchBrainText, listFolder, MAX_BRAIN_BYTES, parseGithubLink } from "./github";
import { readFounder } from "./founders";

type Reply = { status: number; body?: string; headers?: Record<string, string> };
/** A GitHub that answers from a table of URL prefixes, and records what was asked. */
const fakeGithub = (table: Record<string, Reply>) => {
  const asked: string[] = [];
  const fetcher = async (url: string) => {
    asked.push(url);
    const key = Object.keys(table).find((k) => url.startsWith(k));
    const reply = key ? table[key] : { status: 404 };
    return { ok: reply.status < 400, status: reply.status, text: async () => reply.body ?? "", headers: { get: (n: string) => reply.headers?.[n.toLowerCase()] ?? null } };
  };
  return { fetcher, asked };
};
const listing = (names: { name: string; size?: number; type?: string }[], dir: string) =>
  JSON.stringify(names.map((e) => ({ name: e.name, path: `${dir}/${e.name}`, type: e.type ?? "file", size: e.size ?? 1000, download_url: `https://raw.githubusercontent.com/o/r/main/${dir}/${e.name}` })));

describe("GitHub links", () => {
  it("understands file, raw, folder, repository and short links", () => {
    expect(parseGithubLink("https://github.com/o/r/blob/main/assets/brain.json")).toEqual({ kind: "file", name: "brain.json", url: "https://raw.githubusercontent.com/o/r/main/assets/brain.json" });
    expect(parseGithubLink("https://raw.githubusercontent.com/o/r/main/x/y.json")).toEqual({ kind: "file", name: "y.json", url: "https://raw.githubusercontent.com/o/r/main/x/y.json" });
    expect(parseGithubLink("https://github.com/o/r/tree/dev/saved/brains")).toEqual({ kind: "folder", owner: "o", repo: "r", ref: "dev", path: "saved/brains" });
    expect(parseGithubLink("https://github.com/o/r")).toEqual({ kind: "folder", owner: "o", repo: "r", ref: null, path: "" });
    expect(parseGithubLink("https://github.com/o/r.git")).toMatchObject({ kind: "folder", repo: "r" });
    expect(parseGithubLink("o/r/assets/b.json")).toMatchObject({ kind: "file", name: "b.json" });
    expect(parseGithubLink("o/r/assets")).toMatchObject({ kind: "folder", path: "assets" });
  });

  it("refuses anything that is not a GitHub link, in plain words", () => {
    expect(() => parseGithubLink("")).toThrow(/Paste a GitHub link/);
    expect(() => parseGithubLink("http://github.com/o/r")).toThrow(/https/);
    expect(() => parseGithubLink("https://evil.example/o/r/blob/main/a.json")).toThrow(/github\.com/);
    expect(() => parseGithubLink("not a link")).toThrow(/not a GitHub link/);
    expect(() => parseGithubLink("https://github.com/o/r/blob/main")).toThrow(/file/);
  });

  it("guesses the repository from a github.io address, and falls back to this project's", () => {
    expect(defaultRepo({ hostname: "someone.github.io", pathname: "/fly-project/evolve.html" })).toEqual({ owner: "someone", repo: "fly-project" });
    expect(defaultRepo({ hostname: "localhost", pathname: "/evolve.html" })).toEqual({ owner: "nomsams", repo: "flykart" });
  });
});

describe("listing and fetching brains", () => {
  it("lists only the .json files of a folder, and not the oversized ones", async () => {
    const { fetcher, asked } = fakeGithub({
      "https://api.github.com/repos/o/r/contents/saved": { status: 200, body: listing([{ name: "a.json" }, { name: "notes.md" }, { name: "sub", type: "dir" }, { name: "huge.json", size: MAX_BRAIN_BYTES + 1 }, { name: "B.JSON" }], "saved") },
    });
    const files = await listFolder({ kind: "folder", owner: "o", repo: "r", ref: "dev", path: "saved" }, fetcher);
    expect(files.map((f) => f.name)).toEqual(["a.json", "B.JSON"]);
    expect(asked[0]).toBe("https://api.github.com/repos/o/r/contents/saved?ref=dev");
  });

  it("says what went wrong: missing repository, rate limit, no connection", async () => {
    const missing = fakeGithub({});
    await expect(listFolder({ kind: "folder", owner: "o", repo: "r", ref: null, path: "" }, missing.fetcher)).rejects.toThrow(/not found.*public/);
    const limited = fakeGithub({ "https://api.github.com": { status: 403, headers: { "x-ratelimit-remaining": "0" } } });
    await expect(listFolder({ kind: "folder", owner: "o", repo: "r", ref: null, path: "" }, limited.fetcher)).rejects.toThrow(/limit.*one brain file still works/);
    const offline = async () => { throw new TypeError("Failed to fetch"); };
    await expect(listFolder({ kind: "folder", owner: "o", repo: "r", ref: null, path: "" }, offline as never)).rejects.toThrow(/Could not reach GitHub/);
  });

  it("browses the usual folders of a repository and skips the ones it does not have", async () => {
    const { fetcher, asked } = fakeGithub({
      "https://api.github.com/repos/o/r/contents/assets": { status: 200, body: listing([{ name: "one.json" }], "assets") },
      "https://api.github.com/repos/o/r/contents/public/vision/robot": { status: 200, body: listing([{ name: "two.json" }, { name: "three.json" }], "public/vision/robot") },
    });
    const files = await browseRepository("o", "r", fetcher);
    expect(files.map((f) => f.path)).toEqual(["assets/one.json", "public/vision/robot/two.json", "public/vision/robot/three.json"]);
    expect(asked.length).toBe(3); // "brains/" does not exist: skipped, not an error
    const offline = async () => { throw new TypeError("Failed to fetch"); };
    await expect(browseRepository("o", "r", offline as never)).rejects.toThrow(/Could not reach GitHub/);
  });

  it("fetches a brain file and the founder reader accepts it; other hosts and big files are refused", async () => {
    const brain = JSON.stringify({ format: "flykart-brain", version: 2, network: new SpikingNetwork(8, 19).toJSON() });
    const { fetcher } = fakeGithub({ "https://raw.githubusercontent.com/o/r/main/b.json": { status: 200, body: brain }, "https://raw.githubusercontent.com/o/r/main/big.json": { status: 200, body: "x".repeat(MAX_BRAIN_BYTES + 1) } });
    const text = await fetchBrainText("https://raw.githubusercontent.com/o/r/main/b.json", fetcher);
    expect(readFounder(text, "GitHub: b.json").brain.inputCount).toBe(19);
    await expect(fetchBrainText("https://raw.githubusercontent.com/o/r/main/big.json", fetcher)).rejects.toThrow(/too big/);
    await expect(fetchBrainText("https://example.com/b.json", fetcher)).rejects.toThrow(/Only GitHub/);
  });
});
