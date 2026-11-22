// parliament-crawler.ts
// Crawls the Lebanese Parliament archive and exports it as JSONL, JSON and SQLite.
// Run: npm install && npm run crawl   (Node >= 22.18, which runs .ts files natively)
//
// Output:
//   output/records.jsonl     one record per line, appended as the crawl runs
//   output/records.json      the same records as one JSON array, written at the end
//   output/parliament.db     SQLite: `pages` table + `pages_fts` full-text index
//   output/crawl-state.json  checkpoint used to resume an interrupted crawl
//
// How it works:
//   - parses session list pages like N51-7.HTM / E51-7.HTM
//   - parses transcript pages like .../000.HTM, 001.HTM, ...
//   - follows pagination using next/prev image links
//   - groups transcript pages into one logical "session transcript" record

import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import fs from "fs/promises";
import path from "path";
import Database from "better-sqlite3";
import readline from "readline/promises";

const BASE = "http://77.42.251.205/parliament/";
const START_URL = new URL("explore/DAOR.HTM", BASE).href;

const OUTPUT_DIR = "./output";
const RECORDS_JSONL_PATH = path.join(OUTPUT_DIR, "records.jsonl");
const RECORDS_JSON_PATH = path.join(OUTPUT_DIR, "records.json");
const DB_PATH = path.join(OUTPUT_DIR, "parliament.db");
const STATE_PATH = path.join(OUTPUT_DIR, "crawl-state.json");

const MAX_FETCH_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 800;

const visited = new Set();
const queued = new Set();
const queue = [];

const records = [];
const transcriptSeedsSeen = new Set();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadJsonlRecords(filePath) {
  if (!(await fileExists(filePath))) return [];
  const raw = await fs.readFile(filePath, "utf8");
  if (!raw.trim()) return [];

  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // ignore malformed tail lines from interrupted writes
    }
  }
  return out;
}

function snapshotState() {
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    progress: {
      records_count: records.length,
      visited_count: visited.size,
      queued_count: queue.length,
    },
    visited: [...visited],
    queued: [...queued],
    queue: [...queue],
    transcript_seeds_seen: [...transcriptSeedsSeen],
  };
}

async function saveStateCheckpoint() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const tmpPath = `${STATE_PATH}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(snapshotState(), null, 2), "utf8");
  await fs.rename(tmpPath, STATE_PATH);
}

async function loadStateCheckpoint() {
  if (!(await fileExists(STATE_PATH))) return null;
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      !Array.isArray(parsed.queue) ||
      !Array.isArray(parsed.visited)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function clearInMemoryState() {
  visited.clear();
  queued.clear();
  queue.length = 0;
  records.length = 0;
  transcriptSeedsSeen.clear();
}

function restoreFromCheckpoint(state) {
  clearInMemoryState();
  for (const v of state.visited || []) visited.add(v);
  for (const q of state.queued || []) queued.add(q);
  for (const q of state.queue || []) queue.push(q);
  for (const t of state.transcript_seeds_seen || []) transcriptSeedsSeen.add(t);
}

async function promptStartMode({ hasJsonl, hasDb, checkpoint }) {
  const hasAnyOutput = hasJsonl || hasDb || Boolean(checkpoint);
  if (!hasAnyOutput) return "start_over";

  const resumePoint = checkpoint
    ? `${checkpoint.progress?.records_count || 0} records, ${checkpoint.progress?.visited_count || 0} visited URLs, ${checkpoint.progress?.queued_count || 0} queued`
    : "no checkpoint found";

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (checkpoint) {
      console.log(
        `Existing output found. Non-interactive mode: resuming from ${resumePoint}.`,
      );
      return "resume";
    }
    console.log(
      "Existing output found but no checkpoint. Non-interactive mode: starting over.",
    );
    return "start_over";
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log("Existing output detected.");
    console.log(`Resume point: ${resumePoint}`);

    while (true) {
      const answer = (
        await rl.question("Choose: [R]esume / [S]tart over / [Q]uit: ")
      )
        .trim()
        .toLowerCase();

      if (answer === "q" || answer === "quit") return "quit";
      if (answer === "s" || answer === "start" || answer === "start over") {
        return "start_over";
      }
      if (answer === "r" || answer === "resume") {
        if (checkpoint) return "resume";
        console.log(
          "Cannot resume without a checkpoint file. Choose start over or quit.",
        );
      }
    }
  } finally {
    rl.close();
  }
}

async function appendRecordJsonl(record) {
  await fs.appendFile(
    RECORDS_JSONL_PATH,
    `${JSON.stringify(record)}\n`,
    "utf8",
  );
}

function pushUrl(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) return;
  if (visited.has(normalized) || queued.has(normalized)) return;
  queued.add(normalized);
  queue.push(normalized);
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    u.pathname = u.pathname.replace(/\\/g, "/");
    return u.href;
  } catch {
    return null;
  }
}

function resolveUrl(href, currentUrl) {
  if (!href) return null;
  href = href.trim();
  if (!href) return null;
  if (/^(javascript:|mailto:)/i.test(href)) return null;

  try {
    return normalizeUrl(new URL(href.replace(/\\/g, "/"), currentUrl).href);
  } catch {
    return null;
  }
}

function isParliamentUrl(url) {
  try {
    const u = new URL(url);
    return (
      u.hostname === "77.42.251.205" &&
      u.pathname.toLowerCase().startsWith("/parliament/")
    );
  } catch {
    return false;
  }
}

function cleanText(s) {
  return (s || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanMultilineText(s) {
  return (s || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function inferEncoding(headers) {
  const ct = headers.get("content-type") || "";
  const m = ct.match(/charset=([^;]+)/i);
  if (m) return m[1].trim().toLowerCase();
  return "windows-1256";
}

function decodeHtml(arrayBuffer, headers) {
  const enc = inferEncoding(headers);
  const aliases = {
    utf8: "utf-8",
    cp1256: "windows-1256",
    windows1256: "windows-1256",
    iso88596: "iso-8859-6",
    "iso-8859-6": "iso-8859-6",
  };
  const chosen = aliases[enc] || enc;
  try {
    return iconv.decode(Buffer.from(arrayBuffer), chosen);
  } catch {
    return iconv.decode(Buffer.from(arrayBuffer), "windows-1256");
  }
}

async function fetchHtml(url) {
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_FETCH_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; LebanonParliamentCrawler/2.0)",
          Accept: "text/html,application/xhtml+xml,*/*",
        },
      });

      if (!res.ok) {
        const isTemporary = res.status >= 500 || res.status === 429;
        if (!isTemporary || attempt === MAX_FETCH_RETRIES) {
          throw new Error(`HTTP ${res.status}`);
        }

        const jitter = Math.floor(Math.random() * 300);
        const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + jitter;
        console.warn(
          `Temporary HTTP ${res.status} on ${url}. Retry ${attempt}/${MAX_FETCH_RETRIES} in ${delay}ms`,
        );
        await sleep(delay);
        continue;
      }

      const arrayBuffer = await res.arrayBuffer();
      const html = decodeHtml(arrayBuffer, res.headers);

      return {
        url: normalizeUrl(res.url),
        html,
      };
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_FETCH_RETRIES) break;

      const jitter = Math.floor(Math.random() * 300);
      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + jitter;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(
        `Fetch error on ${url}: ${errMsg}. Retry ${attempt}/${MAX_FETCH_RETRIES} in ${delay}ms`,
      );
      await sleep(delay);
    }
  }

  if (lastErr instanceof Error) {
    throw lastErr;
  }
  throw new Error(String(lastErr || "Fetch failed"));
}

function loadHtml(html) {
  return cheerio.load(html, { decodeEntities: false });
}

function getPageTitle($) {
  const selectors = [
    'p[align="Center"] font[size="5"]',
    'p[align="Center"] font[size="4"]',
    "font[size='5']",
    "title",
  ];

  for (const sel of selectors) {
    const t = cleanText($(sel).first().text());
    if (t) return t;
  }
  return "";
}

function extractLinks($, currentUrl) {
  const links = [];
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    const url = resolveUrl(href, currentUrl);
    if (!url) return;
    links.push({
      href,
      url,
      text: cleanText($(a).text()),
    });
  });
  return links;
}

function inferKindFromLabel(label) {
  const t = cleanText(label);
  if (t.includes("محاضر الجلسات")) return "session_index";
  if (t.includes("اسماء النواب")) return "deputies";
  if (t.includes("هيئة المجلس")) return "council";
  if (t.includes("الحكومات")) return "governments";
  if (t.includes("الجلسات")) return "sessions";
  if (t.includes("قرارات")) return "decisions";
  if (t.includes("العقد العادي")) return "ordinary_session";
  if (t.includes("العقد الاستثنائي")) return "extraordinary_session";
  return "unknown";
}

function inferLegislatureCodeFromUrl(url) {
  const pathname = new URL(url).pathname;
  return path.basename(pathname).replace(/\.(htm|html)$/i, "");
}

function parseDateNumericDMY(s) {
  const text = cleanText(s);
  const m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

function classifyPage(url, $, html) {
  const lower = url.toLowerCase();
  const bodyText = cleanText($("body").text());

  if (
    lower.endsWith("/explore/daor.htm") ||
    lower.endsWith("/explore/daor.html")
  ) {
    return "front_index";
  }
  if (/\/explore\/ca\.html$/i.test(lower)) {
    return "lajna_idariya_index";
  }
  if (lower.includes("/depute/")) {
    return "deputies_page";
  }
  if (lower.includes("/conseil/")) {
    return "council_page";
  }
  if (lower.includes("/gouvernement/")) {
    return "government_page";
  }

  // session transcript pages: usually .../000.HTM, 001.HTM, etc.
  if (/\/p\d+\/\d{4}\/p.*\/\d{3}\.html?$/i.test(lower)) {
    return "session_transcript_page";
  }

  // session list pages like N51-7.HTM or E51-7.HTM
  if (
    /\/explore\/[ne]\d{2,4}-\d+\.html?$/i.test(lower) &&
    /الجلسة|العقد العادي|العقد الاستثنائي/.test(bodyText)
  ) {
    return "session_list_page";
  }

  if (
    lower.includes("/explore/") &&
    /محاضر الجلسات|اسماء النواب|هيئة المجلس|الحكومات/.test(bodyText)
  ) {
    return "legislature_landing";
  }

  if (
    lower.includes("/explore/") &&
    /العقد العادي|العقد الاستثنائي|الجلسات|قرارات/.test(bodyText)
  ) {
    return "session_year_page";
  }

  return "other";
}

function extractFrontIndex($, url) {
  const title = getPageTitle($);
  const items = [];

  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    const abs = resolveUrl(href, url);
    if (!abs) return;
    items.push({
      label_ar: cleanText($(a).text()),
      url: abs,
      kind: inferKindFromLabel($(a).text()),
      context_ar: cleanText($(a).closest("p, td").text()),
    });
  });

  return {
    type: "front_index",
    source_url: url,
    title_ar: title,
    items,
  };
}

function extractLegislatureLanding($, url) {
  const title = getPageTitle($);
  const code = inferLegislatureCodeFromUrl(url);
  const items = [];

  $("p").each((_, p) => {
    const anchors = $(p).find("a[href]");
    if (!anchors.length) return;

    const context = cleanText($(p).text());
    const links = [];

    anchors.each((__, a) => {
      const href = $(a).attr("href");
      const abs = resolveUrl(href, url);
      if (!abs) return;
      links.push({
        label_ar: cleanText($(a).text()),
        url: abs,
        kind: inferKindFromLabel($(a).text()),
      });
    });

    if (links.length) {
      items.push({ context_ar: context, links });
    }
  });

  return {
    type: "legislature_landing",
    source_url: url,
    title_ar: title,
    legislature_code: code,
    items,
  };
}

function extractSessionYearPage($, url) {
  const title = getPageTitle($);
  const code = inferLegislatureCodeFromUrl(url);

  const years = [];
  let currentYear = null;

  $("table tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (!tds.length) return;

    const rowText = cleanText($(tr).text());
    const ym = rowText.match(/\b(19\d{2}|20\d{2})\b/);
    if (ym) currentYear = Number(ym[1]);

    const links = [];
    $(tr)
      .find("a[href]")
      .each((__, a) => {
        const href = $(a).attr("href");
        const abs = resolveUrl(href, url);
        if (!abs) return;
        links.push({
          label_ar: cleanText($(a).text()),
          url: abs,
          kind: inferKindFromLabel($(a).text()),
        });
      });

    if (currentYear || links.length) {
      years.push({
        year: currentYear,
        row_text_ar: rowText,
        links,
      });
    }
  });

  return {
    type: "session_year_page",
    source_url: url,
    title_ar: title,
    legislature_code: code,
    years,
  };
}

function extractDeputiesPage($, url) {
  const title = getPageTitle($);
  const code = inferLegislatureCodeFromUrl(url);

  const deputyCountText = cleanText(
    $("p")
      .filter((_, p) => cleanText($(p).text()).includes("عدد النواب"))
      .first()
      .text(),
  );

  const deputyCountMatch = deputyCountText.match(/عدد النواب\s*:?\s*(\d+)/);
  const deputyCount = deputyCountMatch ? Number(deputyCountMatch[1]) : null;

  const rows = [];
  $("table")
    .first()
    .find("tr")
    .each((_, tr) => {
      const cells = [];
      $(tr)
        .find("td")
        .each((__, td) => cells.push(cleanMultilineText($(td).text())));
      if (cells.length) rows.push(cells);
    });

  let deputies = [];
  if (rows.length >= 2) {
    const headers = rows[0];
    deputies = rows.slice(1).map((r) => {
      const obj = {};
      headers.forEach((h, i) => (obj[h || `col_${i}`] = r[i] || ""));
      return {
        index: obj[""] || obj["col_0"] || "",
        name_ar: obj["الاسم"] || "",
        city_ar: obj["المدينة"] || "",
        sect_ar: obj["المذهب"] || "",
        notes_ar: obj["ملاحظات"] || "",
        raw: obj,
      };
    });
  }

  return {
    type: "deputies_page",
    source_url: url,
    title_ar: title,
    legislature_code: code,
    deputy_count: deputyCount,
    rows: deputies,
  };
}

function extractCouncilPage($, url) {
  const title = getPageTitle($);
  const code = inferLegislatureCodeFromUrl(url);

  const chunks = cleanMultilineText($("body").text())
    .split(/(?=سنة\s*:)/)
    .map((x) => x.trim())
    .filter(Boolean);

  const years = chunks.map((chunk) => {
    const year = chunk.match(/سنة\s*:\s*(\d{4})/);
    const president = chunk.match(/الرئيس\s*[:：]\s*([^\n]+)/);
    const vice = chunk.match(/نائب الرئيس\s*[:：]\s*([^\n]+)/);
    const secretariat = chunk.match(/امانة السر\s*[:：]\s*([^\n]+)/);

    return {
      year: year ? Number(year[1]) : null,
      president_ar: president ? cleanText(president[1]) : "",
      vice_president_ar: vice ? cleanText(vice[1]) : "",
      secretariat_ar: secretariat ? cleanText(secretariat[1]) : "",
      raw_text_ar: chunk,
    };
  });

  return {
    type: "council_page",
    source_url: url,
    title_ar: title,
    legislature_code: code,
    years,
  };
}

function extractGovernmentPage($, url) {
  const title = getPageTitle($);
  const code = inferLegislatureCodeFromUrl(url);
  const governments = [];

  let current = null;

  $("body")
    .children()
    .each((_, el) => {
      const tag = (el.tagName || "").toLowerCase();
      const text = cleanMultilineText($(el).text());
      if (!text) return;

      if (tag === "p" && /حكومة\s*:|حكومة:/.test(text)) {
        if (current) governments.push(current);

        const nameMatch = text.match(/حكومة\s*:\s*(.+?)(?:من\s*:|$)/);
        const datesMatch = text.match(
          /من\s*:?\s*([0-9/]+)\s*الى\s*:?\s*([0-9/]+)/,
        );

        current = {
          government_name_ar: nameMatch ? cleanText(nameMatch[1]) : "",
          from: datesMatch ? parseDateNumericDMY(datesMatch[1]) : null,
          to: datesMatch ? parseDateNumericDMY(datesMatch[2]) : null,
          header_ar: text,
          members: [],
        };
        return;
      }

      if (tag === "table" && current) {
        const rows = [];
        $(el)
          .find("tr")
          .each((__, tr) => {
            const cells = [];
            $(tr)
              .find("td")
              .each((___, td) => cells.push(cleanMultilineText($(td).text())));
            if (cells.length) rows.push(cells);
          });

        if (rows.length >= 2) {
          const headers = rows[0];
          const members = rows.slice(1).map((r) => {
            const obj = {};
            headers.forEach((h, i) => (obj[h || `col_${i}`] = r[i] || ""));
            return {
              index: obj[""] || obj["col_0"] || "",
              name_ar: obj["الاسم"] || "",
              portfolio_ar: obj["وزارة"] || "",
              raw: obj,
            };
          });
          current.members.push(...members);
        }
      }
    });

  if (current) governments.push(current);

  return {
    type: "government_page",
    source_url: url,
    title_ar: title,
    legislature_code: code,
    governments,
  };
}

function extractSessionListPage($, url) {
  const title = getPageTitle($);
  const code = inferLegislatureCodeFromUrl(url);
  const bodyText = cleanMultilineText($("body").text());

  let session_type = null;
  if (/العقد العادي/.test(bodyText)) session_type = "ordinary";
  if (/العقد الاستثنائي/.test(bodyText)) session_type = "extraordinary";

  const yearMatch = bodyText.match(/سنة\s+(\d{4})/);
  const year = yearMatch ? Number(yearMatch[1]) : null;

  const session_block_label = [];
  $("li").each((_, li) => {
    const t = cleanText($(li).text());
    if (t) session_block_label.push(t);
  });

  const sessions = [];
  $("table a[href]").each((_, a) => {
    const href = $(a).attr("href");
    const abs = resolveUrl(href, url);
    if (!abs) return;

    const label = cleanText($(a).text());
    const pageNoMatch = abs.match(/\/(\d{3})\.htm$/i);
    sessions.push({
      label_ar: label,
      url: abs,
      first_page_file: pageNoMatch ? pageNoMatch[1] : null,
    });
  });

  return {
    type: "session_list_page",
    source_url: url,
    title_ar: title,
    legislature_code: code,
    year,
    session_type,
    block_labels_ar: session_block_label,
    sessions,
  };
}

function parseTranscriptPageMeta($, url) {
  const bodyText = cleanMultilineText($("body").text());

  const headingMain = cleanMultilineText($('p[align="Center"]').first().text());

  const metaCenterBlocks = [];
  $('p[align="Center"]').each((_, p) => {
    const t = cleanMultilineText($(p).text());
    if (t) metaCenterBlocks.push(t);
  });

  const dod = $('sindex[stype="Dod"]').attr("svalue") || null;
  const subj =
    $('sindex[stype="Subj"], sindex[stype="Subj"], sindex[stype="subj"]').attr(
      "svalue",
    ) || null;

  const legislatureMatch =
    bodyText.match(/الدور التشريعي\s+([^\n]+)/) ||
    headingMain.match(/الدور التشريعي\s+([^\n]+)/);

  const sessionLineMatch = bodyText.match(/محضر\s+الجلسة\s+([^\n]+)/);
  const sessionHeldMatch = bodyText.match(/يوم\s+([^\n]+)/);

  return {
    transcript_heading_ar: headingMain,
    legislature_label_ar: legislatureMatch
      ? cleanText(`الدور التشريعي ${legislatureMatch[1]}`)
      : "",
    session_heading_ar: sessionLineMatch
      ? cleanText(`محضر الجلسة ${sessionLineMatch[1]}`)
      : "",
    held_on_text_ar: sessionHeldMatch
      ? cleanText(`يوم ${sessionHeldMatch[1]}`)
      : "",
    dod_raw: dod,
    dod_iso: dod ? parseDateNumericDMY(dod) : null,
    subj_raw: subj,
    center_blocks_ar: metaCenterBlocks,
  };
}

function extractIndexEntries($) {
  const out = [];
  $("p[align='right']").each((_, p) => {
    const text = cleanText($(p).text());
    if (!text) return;
    if (/^فهرست/.test(text)) return;
    if (/^\d+\s*ـ/.test(text) || /^[أ-ي]\s*ـ/.test(text)) {
      out.push(text);
    }
  });
  return out;
}

function extractRightBarLinks($, url) {
  const links = [];
  $("td a[href]").each((_, a) => {
    const href = $(a).attr("href");
    const abs = resolveUrl(href, url);
    if (!abs) return;

    const imgSrc = $(a).find("img").attr("src") || "";
    const text = cleanText($(a).text());
    links.push({
      url: abs,
      text_ar: text,
      img_src: imgSrc.replace(/\\/g, "/"),
    });
  });
  return links;
}

function getNextTranscriptUrl($, url) {
  let next = null;
  $("a[href]").each((_, a) => {
    const imgSrc = ($(a).find("img").attr("src") || "")
      .replace(/\\/g, "/")
      .toUpperCase();
    if (imgSrc.includes("/B.GIF") || imgSrc.endsWith("B.GIF")) {
      next = resolveUrl($(a).attr("href"), url);
    }
  });
  return next;
}

function getPrevTranscriptUrl($, url) {
  let prev = null;
  $("a[href]").each((_, a) => {
    const imgSrc = ($(a).find("img").attr("src") || "")
      .replace(/\\/g, "/")
      .toUpperCase();
    if (imgSrc.includes("/N.GIF") || imgSrc.endsWith("N.GIF")) {
      prev = resolveUrl($(a).attr("href"), url);
    }
  });
  return prev;
}

function stripNoiseAndExtractBodyText($) {
  // remove script/style and navigation-ish sections
  $("script, style, sindex").remove();

  // clone body so we can safely remove nav
  const bodyClone = $("body").clone();

  bodyClone.find("a[href]").each((_, a) => {
    const img = bodyClone.find(a).find("img");
    const src = (img.attr("src") || "").toUpperCase();
    if (
      src.includes("B.GIF") ||
      src.includes("N.GIF") ||
      src.includes("BDAAIA.GIF") ||
      src.includes("BDAJAL.GIF") ||
      src.includes("FLAG.GIF")
    ) {
      bodyClone.find(a).remove();
    }
  });

  return cleanMultilineText(bodyClone.text());
}

async function extractSessionTranscriptRecord(seedUrl) {
  const normalizedSeed = normalizeUrl(seedUrl);
  if (!normalizedSeed) return null;
  if (transcriptSeedsSeen.has(normalizedSeed)) return null;

  transcriptSeedsSeen.add(normalizedSeed);

  const pages = [];
  let currentUrl = normalizedSeed;
  const seen = new Set();

  while (currentUrl && !seen.has(currentUrl)) {
    seen.add(currentUrl);

    const { url: finalUrl, html } = await fetchHtml(currentUrl);
    visited.add(finalUrl);

    const $ = loadHtml(html);
    const meta = parseTranscriptPageMeta($, finalUrl);
    const nextUrl = getNextTranscriptUrl($, finalUrl);
    const prevUrl = getPrevTranscriptUrl($, finalUrl);

    const pathname = new URL(finalUrl).pathname;
    const pageFile = path.basename(pathname).replace(/\.(htm|html)$/i, "");
    const sessionDir = path.basename(path.dirname(pathname));

    pages.push({
      page_url: finalUrl,
      page_file: pageFile,
      session_dir: sessionDir,
      next_url: nextUrl,
      prev_url: prevUrl,
      page_text_ar: stripNoiseAndExtractBodyText($),
      index_entries_ar: extractIndexEntries($),
      meta,
      right_bar_links: extractRightBarLinks($, finalUrl),
    });

    if (!nextUrl || seen.has(nextUrl)) break;
    currentUrl = nextUrl;
  }

  if (!pages.length) return null;

  const first = pages[0];
  const joinedText = pages.map((p) => p.page_text_ar).join("\n\n");

  return {
    type: "session_transcript",
    source_url: normalizedSeed,
    transcript_root_dir: first.session_dir,
    page_count: pages.length,
    dod_iso: first.meta.dod_iso,
    dod_raw: first.meta.dod_raw,
    legislature_label_ar: first.meta.legislature_label_ar,
    session_heading_ar: first.meta.session_heading_ar,
    transcript_heading_ar: first.meta.transcript_heading_ar,
    held_on_text_ar: first.meta.held_on_text_ar,
    subj_raw: first.meta.subj_raw,
    index_entries_ar: first.index_entries_ar,
    full_text_ar: joinedText,
    pages,
  };
}

function extractOtherPage($, url) {
  return {
    type: "other",
    source_url: url,
    title_ar: getPageTitle($),
    text_ar: cleanMultilineText($("body").text()),
  };
}

async function parseAndMaybeExpand(url, html) {
  const $ = loadHtml(html);
  const pageType = classifyPage(url, $, html);

  let record;
  let links = extractLinks($, url);

  switch (pageType) {
    case "front_index":
      record = extractFrontIndex($, url);
      break;
    case "lajna_idariya_index":
      record = extractSessionYearPage($, url);
      break;
    case "legislature_landing":
      record = extractLegislatureLanding($, url);
      break;
    case "session_year_page":
      record = extractSessionYearPage($, url);
      break;
    case "deputies_page":
      record = extractDeputiesPage($, url);
      break;
    case "council_page":
      record = extractCouncilPage($, url);
      break;
    case "government_page":
      record = extractGovernmentPage($, url);
      break;
    case "session_list_page":
      record = extractSessionListPage($, url);
      break;
    case "session_transcript_page":
      // don't store every page separately; store one grouped transcript record
      record = await extractSessionTranscriptRecord(url);
      links = []; // already followed internally via next-page links
      break;
    default:
      record = extractOtherPage($, url);
      break;
  }

  return { record, links, pageType };
}

function shouldQueueLink(url) {
  if (!url) return false;
  if (!isParliamentUrl(url)) return false;
  if (/\.(gif|jpg|jpeg|png|bmp|pdf|doc|docx|xls|xlsx)$/i.test(url))
    return false;
  return true;
}

function initDb(dbPath) {
  const db = new Database(dbPath);

  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS pages (
      source_url TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title_ar TEXT,
      legislature_code TEXT,
      dod_iso TEXT,
      json TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
      source_url,
      type,
      title_ar,
      body_text_ar
    );
  `);

  return db;
}

function createDbWriters(db) {
  return {
    insert: db.prepare(`
    INSERT OR REPLACE INTO pages (source_url, type, title_ar, legislature_code, dod_iso, json)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
    ftsDeleteBySourceUrl: db.prepare(`
    DELETE FROM pages_fts WHERE source_url = ?
  `),
    ftsInsert: db.prepare(`
    INSERT INTO pages_fts (source_url, type, title_ar, body_text_ar)
    VALUES (?, ?, ?, ?)
  `),
    pagesCount: db.prepare(`
    SELECT COUNT(*) AS c FROM pages
  `),
  };
}

function indexRecordInDb(dbWriters, record) {
  if (!record?.source_url || !record?.type) return;

  const title =
    record.title_ar ||
    record.transcript_heading_ar ||
    record.session_heading_ar ||
    "";
  const legislatureCode = record.legislature_code || null;
  const dodIso = record.dod_iso || null;

  dbWriters.insert.run(
    record.source_url,
    record.type,
    title,
    legislatureCode,
    dodIso,
    JSON.stringify(record),
  );

  const bodyText =
    record.full_text_ar || record.text_ar || JSON.stringify(record);

  dbWriters.ftsDeleteBySourceUrl.run(record.source_url);
  dbWriters.ftsInsert.run(record.source_url, record.type, title, bodyText);
}

async function saveFinalOutputs() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(
    RECORDS_JSON_PATH,
    JSON.stringify(records, null, 2),
    "utf8",
  );
}

async function initializeRun() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const [hasJsonl, hasDb, checkpoint] = await Promise.all([
    fileExists(RECORDS_JSONL_PATH),
    fileExists(DB_PATH),
    loadStateCheckpoint(),
  ]);

  const mode = await promptStartMode({ hasJsonl, hasDb, checkpoint });
  if (mode === "quit") return { quit: true };

  clearInMemoryState();

  if (mode === "resume") {
    if (!checkpoint) {
      throw new Error("Cannot resume without checkpoint file");
    }
    restoreFromCheckpoint(checkpoint);

    const existingRecords = await loadJsonlRecords(RECORDS_JSONL_PATH);
    for (const rec of existingRecords) records.push(rec);

    if (!queue.length) {
      console.log("Checkpoint queue is empty. Nothing left to crawl.");
    }
  } else {
    pushUrl(START_URL);
    await fs.writeFile(RECORDS_JSONL_PATH, "", "utf8");
    await fs.rm(STATE_PATH, { force: true });
    await fs.rm(RECORDS_JSON_PATH, { force: true });
    await fs.rm(DB_PATH, { force: true });
  }

  const db = initDb(DB_PATH);
  const dbWriters = createDbWriters(db);

  if (mode === "resume" && records.length) {
    const pageCount = dbWriters.pagesCount.get()?.c || 0;
    if (!pageCount) {
      for (const rec of records) indexRecordInDb(dbWriters, rec);
      console.log(
        `Rebuilt SQLite index with ${records.length} records from JSONL`,
      );
    }
  }

  return { quit: false, db, dbWriters };
}

async function persistRecord(record, dbWriters) {
  records.push(record);
  await appendRecordJsonl(record);
  indexRecordInDb(dbWriters, record);
}

async function crawl(dbWriters) {
  while (queue.length) {
    const url = queue.shift();
    queued.delete(url);
    if (!url || visited.has(url)) continue;

    try {
      console.log("Fetching", url);
      const { url: finalUrl, html } = await fetchHtml(url);
      if (visited.has(finalUrl)) continue;
      visited.add(finalUrl);

      const { record, links, pageType } = await parseAndMaybeExpand(
        finalUrl,
        html,
      );
      if (record) await persistRecord(record, dbWriters);

      // queue regular discovered links
      for (const link of links) {
        if (!shouldQueueLink(link.url)) continue;
        pushUrl(link.url);
      }

      // special: session list pages contain transcript seeds
      if (record && record.type === "session_list_page") {
        for (const s of record.sessions || []) {
          if (s.url) pushUrl(s.url);
        }
      }

      await saveStateCheckpoint();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("Error on", url, errMsg);
      await persistRecord(
        {
          type: "error",
          source_url: url,
          error: errMsg,
        },
        dbWriters,
      );
      await saveStateCheckpoint();
    }
  }

  await saveFinalOutputs();
  await fs.rm(STATE_PATH, { force: true });
  console.log(`Saved ${records.length} records`);
}

async function main() {
  const initialized = await initializeRun();
  if (initialized.quit) return;

  const { db, dbWriters } = initialized;
  try {
    await crawl(dbWriters);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
