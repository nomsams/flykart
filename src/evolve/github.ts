// Fetching trained brains from GitHub: a link to one file, a link to a folder of them, or a look through this repository.
// Only public repositories are read, with plain GET requests (raw.githubusercontent.com and api.github.com both allow
// browser use). Nothing is sent to GitHub but the path asked for, and nothing is stored but the brain that comes back.

export type GithubTarget =
  | { kind: "file"; name: string; url: string }
  | { kind: "folder"; owner: string; repo: string; ref: string | null; path: string };

export type RemoteFile = { name: string; path: string; url: string; size: number };

type Fetcher = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string>; headers: { get(name: string): string | null } }>;

const SEGMENT = /^[A-Za-z0-9._-]+$/;
/** Brains are a few hundred KB at most (512 neurons is about 1.3 MB of numbers); anything bigger is not one. */
export const MAX_BRAIN_BYTES = 6_000_000;
/** Places this project keeps brains, looked through by "browse": the repository's checkpoints and the bundled controllers. */
export const BRAIN_FOLDERS = ["assets", "public/vision/robot", "brains"];

const rawUrl = (owner: string, repo: string, ref: string, path: string): string => `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;

/**
 * Understand what the person pasted: a github.com file link ("blob"), a raw link, a folder link ("tree"), a bare
 * repository link, or the short form owner/repo[/path]. Throws a sentence that says what was expected.
 */
export function parseGithubLink(input: string): GithubTarget {
  const text = input.trim();
  if (!text) throw new Error("Paste a GitHub link to a brain file or to a folder of brains.");
  let url: URL | null = null;
  try { url = new URL(text); } catch { /* maybe the short form */ }
  if (!url) {
    const parts = text.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length >= 2 && parts.every((p) => SEGMENT.test(p))) {
      const [owner, repo, ...rest] = parts, path = rest.join("/");
      return path.toLowerCase().endsWith(".json")
        ? { kind: "file", name: rest[rest.length - 1], url: rawUrl(owner, repo, "HEAD", path) }
        : { kind: "folder", owner, repo, ref: null, path };
    }
    throw new Error("That is not a GitHub link. Expected something like https://github.com/owner/repo/blob/main/path/brain.json");
  }
  if (url.protocol !== "https:") throw new Error("Only https GitHub links are accepted.");
  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (url.hostname === "raw.githubusercontent.com") {
    if (segments.length < 4) throw new Error("A raw GitHub link needs owner, repository, branch and file path.");
    return { kind: "file", name: segments[segments.length - 1], url: url.toString() };
  }
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") throw new Error("Only github.com and raw.githubusercontent.com links are accepted.");
  const [owner, repo, mode, ref, ...rest] = segments;
  if (!owner || !repo || !SEGMENT.test(owner) || !SEGMENT.test(repo.replace(/\.git$/, ""))) throw new Error("That link does not name a repository.");
  const name = repo.replace(/\.git$/, "");
  if (mode === "blob" || mode === "raw") {
    if (!ref || !rest.length) throw new Error("That link does not point at a file.");
    return { kind: "file", name: rest[rest.length - 1], url: rawUrl(owner, name, ref, rest.join("/")) };
  }
  if (mode === "tree") return { kind: "folder", owner, repo: name, ref: ref ?? null, path: rest.join("/") };
  return { kind: "folder", owner, repo: name, ref: null, path: "" };
}

/** The repository this page was served from (a project page on github.io), or this project's own. */
export function defaultRepo(location?: { hostname: string; pathname: string }): { owner: string; repo: string } {
  const host = location?.hostname ?? "";
  if (host.endsWith(".github.io")) {
    const repo = (location?.pathname ?? "").split("/").filter(Boolean)[0];
    if (repo && SEGMENT.test(repo)) return { owner: host.slice(0, -".github.io".length), repo };
  }
  return { owner: "nomsams", repo: "flykart" };
}

function explain(status: number, headers: { get(name: string): string | null }, what: string): Error {
  if (status === 404) return new Error(`${what} was not found on GitHub. Check the link, and that the repository is public.`);
  if (status === 403 || status === 429) return new Error(headers.get("x-ratelimit-remaining") === "0"
    ? "GitHub's limit for anonymous requests is used up for now (it resets within the hour). A link straight to one brain file still works."
    : `GitHub refused the request (${status}).`);
  return new Error(`GitHub answered ${status} for ${what}.`);
}

/** The .json files directly inside a folder of a public repository. */
export async function listFolder(target: Extract<GithubTarget, { kind: "folder" }>, fetcher: Fetcher = fetch as unknown as Fetcher): Promise<RemoteFile[]> {
  const api = `https://api.github.com/repos/${target.owner}/${target.repo}/contents/${target.path.split("/").map(encodeURIComponent).join("/")}${target.ref ? `?ref=${encodeURIComponent(target.ref)}` : ""}`;
  let response;
  try { response = await fetcher(api, { headers: { Accept: "application/vnd.github+json" } }); } catch { throw new Error("Could not reach GitHub. Check the connection."); }
  if (!response.ok) throw explain(response.status, response.headers, `${target.owner}/${target.repo}/${target.path || ""}`);
  const entries = JSON.parse(await response.text()) as { name: string; path: string; type: string; size: number; download_url: string | null }[];
  if (!Array.isArray(entries)) throw new Error("That link is a file, not a folder.");
  return entries
    .filter((e) => e.type === "file" && e.name.toLowerCase().endsWith(".json") && e.download_url && e.size <= MAX_BRAIN_BYTES)
    .map((e) => ({ name: e.name, path: e.path, url: e.download_url!, size: e.size }));
}

/** Brain files in the usual places of a repository. A folder that does not exist is skipped. */
export async function browseRepository(owner: string, repo: string, fetcher: Fetcher = fetch as unknown as Fetcher): Promise<RemoteFile[]> {
  const out: RemoteFile[] = [];
  let reached = false, lastError: Error | null = null;
  for (const path of BRAIN_FOLDERS) {
    try { out.push(...await listFolder({ kind: "folder", owner, repo, ref: null, path }, fetcher)); reached = true; }
    catch (error) { lastError = error instanceof Error ? error : new Error(String(error)); if (/was not found/.test(lastError.message)) { reached = true; continue; } throw lastError; }
  }
  if (!reached && lastError) throw lastError;
  return out;
}

/** Download one file as text, refusing anything too big to be a brain. */
export async function fetchBrainText(url: string, fetcher: Fetcher = fetch as unknown as Fetcher): Promise<string> {
  if (!/^https:\/\/(raw\.githubusercontent\.com|github\.com|objects\.githubusercontent\.com)\//.test(url)) throw new Error("Only GitHub links can be fetched.");
  let response;
  try { response = await fetcher(url); } catch { throw new Error("Could not reach GitHub. Check the connection."); }
  if (!response.ok) throw explain(response.status, response.headers, url.split("/").slice(-1)[0]);
  const text = await response.text();
  if (text.length > MAX_BRAIN_BYTES) throw new Error("That file is too big to be a brain.");
  return text;
}
