import { execFile } from "node:child_process";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CURL_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export type FetchTextCurlOptions = {
  timeoutSec?: number;
  /** Bazı siteler (Amazon, HB) Referer olmadan boş veya bloklu yanıt verebilir */
  referer?: string;
  /** Bazı WAF’ler HTTP/2 ile isteği daha kolay işaretler */
  useHttp11?: boolean;
  origin?: string;
  /** Varsayılan Accept yerine (örn. JSON API için application/json) */
  accept?: string;
};

/**
 * Node `fetch` bazı TR sitelerinde TLS/bot nedeniyle 403 döner; sistem curl'ü genelde 200 verir.
 */
export async function fetchTextCurl(url: string, options?: FetchTextCurlOptions | number): Promise<string> {
  const opts: FetchTextCurlOptions =
    typeof options === "number" ? { timeoutSec: options } : (options ?? {});
  const timeoutSec = opts.timeoutSec ?? 30;
  const bin = process.platform === "win32" ? "curl.exe" : "curl";
  const args = ["-sL", "--compressed", "-A", CURL_UA];
  if (opts.useHttp11) {
    args.push("--http1.1");
  }
  args.push("-H", "Accept-Language: tr-TR,tr;q=0.9");
  args.push(
    "-H",
    `Accept: ${opts.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"}`
  );
  if (opts.origin) {
    args.push("-H", `Origin: ${opts.origin}`);
  }
  if (opts.referer) {
    args.push("-H", `Referer: ${opts.referer}`);
  }
  args.push("--max-time", String(timeoutSec), url);
  try {
    const { stdout } = await execFileAsync(bin, args, {
      maxBuffer: 14 * 1024 * 1024,
      windowsHide: true,
    });
    const text = typeof stdout === "string" ? stdout : Buffer.from(stdout).toString("utf8");
    if (!text.length) {
      throw new Error("Boş yanıt");
    }
    return text;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error("curl bulunamadı (PATH'te curl veya curl.exe gerekli)");
    }
    throw e;
  }
}

/**
 * Önce warmupUrl’e gidip çerez alır, sonra targetUrl’i aynı oturumla ister (Akamai / HB için).
 */
export async function fetchTextCurlWithSession(
  targetUrl: string,
  warmupUrl: string,
  options?: FetchTextCurlOptions
): Promise<string> {
  const opts = options ?? {};
  const timeoutSec = opts.timeoutSec ?? 35;
  const bin = process.platform === "win32" ? "curl.exe" : "curl";
  const jar = join(tmpdir(), `curl-cookies-${process.pid}-${Date.now()}.txt`);

  const base = ["-sL", "--compressed", "--http1.1", "-A", CURL_UA];

  const run = async (curlArgs: string[]) => {
    const { stdout } = await execFileAsync(bin, curlArgs, {
      maxBuffer: 14 * 1024 * 1024,
      windowsHide: true,
    });
    return typeof stdout === "string" ? stdout : Buffer.from(stdout).toString("utf8");
  };

  try {
    await run([
      ...base,
      "-H",
      "Accept-Language: tr-TR,tr;q=0.9",
      "-H",
      "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "-c",
      jar,
      "--max-time",
      String(timeoutSec),
      warmupUrl,
    ]);

    const html = await run([
      ...base,
      "-H",
      "Accept-Language: tr-TR,tr;q=0.9",
      "-H",
      "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "-b",
      jar,
      "-H",
      `Referer: ${warmupUrl}`,
      ...(opts.origin ? ["-H", `Origin: ${opts.origin}`] : []),
      "--max-time",
      String(timeoutSec),
      targetUrl,
    ]);

    if (!html.length) {
      throw new Error("Boş yanıt");
    }
    return html;
  } finally {
    try {
      unlinkSync(jar);
    } catch {
      /* ignore */
    }
  }
}
