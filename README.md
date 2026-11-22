# legiliban-crawler

A crawler for the online archive of the Lebanese Parliament. It collects session transcripts (محاضر الجلسات), lists of deputies, council and government compositions, and exports them as JSONL, JSON and a searchable SQLite database.

## Download the data

You don't need to run the crawler to use the data. A snapshot crawled in March 2026 is on the [Releases](https://github.com/touficbatache/legiliban-crawler/releases) page:

| File | What it is |
| --- | --- |
| `parliament.db.zst` | SQLite database with a full-text index (Zstandard-compressed) |
| `records.jsonl.zst` | The same records, one JSON object per line |

To decompress:

```bash
zstd -d parliament.db.zst
```

The snapshot holds 4,952 records. (`records.jsonl` has 4,954 lines because two pages were saved twice; the database keeps one copy of each.)

| Record type | Count |
| --- | ---: |
| `session_transcript` | 2,311 |
| `other` | 2,318 |
| `session_list_page` | 202 |
| `session_year_page` | 43 |
| `deputies_page` | 25 |
| `council_page` | 24 |
| `government_page` | 21 |
| `front_index` | 2 |
| `error` | 6 |

## Run the crawler

Requires Node.js 22.18 or later, which runs the TypeScript source directly.

```bash
npm install
npm run crawl
```

Results go to `output/`. If a crawl is interrupted, run the command again and choose **Resume**: the crawler keeps a checkpoint in `output/crawl-state.json`. A full crawl visits about 34,000 pages and produces about 2.8 GB of output.

## Output format

Every record has a `type` and a `source_url`. A `session_transcript` record groups every page of one session:

| Field | Meaning |
| --- | --- |
| `dod_iso` | Session date (`YYYY-MM-DD`) |
| `legislature_label_ar` | Legislature (الدور التشريعي) |
| `session_heading_ar` | Session heading (محضر الجلسة …) |
| `index_entries_ar` | Agenda / index entries |
| `full_text_ar` | Full text of the transcript, all pages joined |
| `pages` | Per-page text, metadata and links |

Text fields ending in `_ar` are in Arabic.

### SQLite schema

```sql
CREATE TABLE pages (
  source_url       TEXT PRIMARY KEY,
  type             TEXT NOT NULL,
  title_ar         TEXT,
  legislature_code TEXT,
  dod_iso          TEXT,
  json             TEXT NOT NULL   -- the full record
);

CREATE VIRTUAL TABLE pages_fts USING fts5(source_url, type, title_ar, body_text_ar);
```

Example: find transcripts that mention a word.

```sql
SELECT p.dod_iso, p.title_ar, p.source_url
FROM pages_fts f JOIN pages p USING (source_url)
WHERE pages_fts MATCH 'الموازنة' AND p.type = 'session_transcript'
ORDER BY p.dod_iso;
```

## Crawl politely

The source server is small. The crawler fetches one page at a time and backs off on errors. Please keep it that way, and use the published snapshot rather than re-crawling when you can.

## License

The code is licensed under the [GNU Affero General Public License v3.0](LICENSE). If you distribute a modified version, or run one as a network service that others use, you must release its source code under the same license.

The crawled content comes from the Lebanese Parliament's archive and is not covered by that license.
