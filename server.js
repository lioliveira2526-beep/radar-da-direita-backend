/**
 * RADAR DA DIREITA - Backend híbrido (RSS + optional NewsAPI)
 * - Atualiza feeds automaticamente (cache + loop)
 * - Endpoints: /api/news, /api/search, /api/categories, /api/premium, /api/articles/:id
 * - Admin: POST /api/admin/refresh (X-ADMIN-TOKEN header)
 */
import express from "express";
import cors from "cors";
import Parser from "rss-parser";
import NodeCache from "node-cache";
import fs from "fs";
import path from "path";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

const app = express();
app.use(cors());
app.use(express.json());

const DATA_DIR = process.cwd();
const FEEDS_FILE = path.join(DATA_DIR, "feeds.json");
const SEED_FILE = path.join(DATA_DIR, "seed", "articles.json");

const PORT = Number(process.env.PORT || 3001);
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 600);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "troque_por_token_forte_aqui";
const NEWSAPI_KEY = process.env.NEWSAPI_KEY || "";

const parser = new Parser({ timeout: 10000 });
const cache = new NodeCache({
  stdTTL: CACHE_TTL_SECONDS,
  checkperiod: Math.max(60, Math.floor(CACHE_TTL_SECONDS / 2))
});

let feeds = [];
let seedArticles = [];

// Load static files
try {
  feeds = JSON.parse(fs.readFileSync(FEEDS_FILE, "utf8"));
} catch (e) {
  feeds = [];
  console.warn("feeds.json missing or invalid");
}

try {
  seedArticles = JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));
} catch (e) {
  seedArticles = [];
  console.warn("seed/articles.json missing or invalid");
}

// Helpers
function nowISO() {
  return new Date().toISOString();
}

function makeArticleId(prefix, input) {
  return `${prefix}-${Buffer.from(String(input)).toString("base64").slice(0, 12)}`;
}

function sanitizeText(s) {
  return (s || "").toString().trim();
}

// Map RSS item → internal structure
function mapRssItem(item, feedName) {
  const id = makeArticleId("rss", item.link || item.guid || item.title || uuidv4());

  return {
    articleId: id,
    title: sanitizeText(item.title || "Sem título"),
    subtitle: sanitizeText(item.contentSnippet || item.description || ""),
    authors: item.creator ? [item.creator] : [feedName || "Fonte"],
    publicationDate: item.isoDate || item.pubDate || nowISO(),
    category: "Política",
    summary: sanitizeText(item.contentSnippet || item.description || ""),
    contentHtml: null,
    isPremium: false,
    isFeatured: false,
    imagePlaceholderUrl: (item.enclosure && item.enclosure.url) || "",
    analysisTags: [],
    source: { name: feedName || "Fonte", url: item.link || "" }
  };
}

// Filter relevance (politics only)
function isRelevantPolitics(text, feedName = "") {
  if (!text) return false;
  const t = text.toLowerCase();

  const block = ["futebol", "esporte", "entretenimento", "receita", "celebridade", "tv", "cinema"];
  for (const b of block) if (t.includes(b)) return false;

  const allow = [
    "política", "politica", "governo", "congresso", "senado",
    "deputado", "eleição", "eleicao", "partido", "reforma", "tributaria",
    "guerra", "geopolít", "geopolit", "economia", "segurança", "seguranca"
  ];

  if (allow.some(k => t.includes(k))) return true;
  if (/politica|poder|congresso|senado/i.test(feedName)) return true;

  return false;
}

// Fetch optional NewsAPI
async function fetchNewsFromNewsAPI() {
  if (!NEWSAPI_KEY) return [];

  try {
    const q = "política OR politica OR governo OR congresso OR eleicao OR eleição OR geopolítica OR guerra";

    const res = await axios.get("https://newsapi.org/v2/top-headlines", {
      params: { country: "br", q, pageSize: 50 },
      headers: { "X-Api-Key": NEWSAPI_KEY },
      timeout: 10000
    });

    return (res.data.articles || []).map(a => ({
      articleId: makeArticleId("newsapi", a.url || a.title || uuidv4()),
      title: sanitizeText(a.title),
      subtitle: sanitizeText(a.description || ""),
      authors: [a.author || a.source?.name || "Fonte"],
      publicationDate: a.publishedAt,
      category: "Política",
      summary: sanitizeText(a.description || ""),
      contentHtml: null,
      isPremium: false,
      isFeatured: false,
      imagePlaceholderUrl: a.urlToImage || "",
      analysisTags: [],
      source: { name: a.source?.name || "NewsAPI", url: a.url || "" }
    }));
  } catch (e) {
    console.warn("NewsAPI fetch failed:", e.message || e);
    return [];
  }
}

// Aggregate everything
async function fetchAndAggregate() {
  const cacheKey = "aggregated_news_v1";
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  let all = [];

  // RSS feeds
  for (const f of feeds) {
    try {
      const feed = await parser.parseURL(f.url);
      const sourceName = f.name || feed.title || "Fonte";

      for (const it of feed.items || []) {
        const mapped = mapRssItem(it, sourceName);
        const text = (mapped.title + " " + mapped.summary).toLowerCase();
        if (isRelevantPolitics(text, sourceName)) all.push(mapped);
      }
    } catch (e) {
      console.warn("Fail parse feed:", f.url, e.message || e);
    }
  }

  // Optional NewsAPI
  const fromNewsApi = await fetchNewsFromNewsAPI();
  if (fromNewsApi.length) all.push(...fromNewsApi);

  // Dedup
  const seen = new Set();
  const dedup = [];

  for (const a of all) {
    const key = `${a.title}|${a.source?.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      dedup.push(a);
    }
  }

  // Merge seed premium
  const merged = [...seedArticles.filter(s => s.isFeatured), ...dedup];
  merged.sort((x, y) => new Date(y.publicationDate) - new Date(x.publicationDate));

  cache.set(cacheKey, merged);
  return merged;
}

// Periodic refresh loop
async function refreshLoop() {
  try {
    await fetchAndAggregate();
  } catch (e) {
    console.error("refreshLoop error", e.message || e);
  }
  setTimeout(refreshLoop, CACHE_TTL_SECONDS * 1000);
}

fetchAndAggregate()
  .then(() => setTimeout(refreshLoop, CACHE_TTL_SECONDS * 1000))
  .catch(() => setTimeout(refreshLoop, CACHE_TTL_SECONDS * 1000));

// ENDPOINTS ==============================

app.get("/api/health", (req, res) => {
  res.json({ ok: true, now: nowISO() });
});

app.get("/api/news", async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(100, Number(req.query.pageSize || 30));

    const all = await fetchAndAggregate();
    const start = (page - 1) * pageSize;

    res.json({
      total: all.length,
      page,
      pageSize,
      items: all.slice(start, start + pageSize)
    });
  } catch (e) {
    res.status(500).json({ error: "failed" });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim().toLowerCase();
    if (!q) return res.json([]);

    const all = await fetchAndAggregate();
    const found = all.filter(a =>
      (a.title + " " + (a.summary || "")).toLowerCase().includes(q)
    );

    res.json(found.slice(0, 200));
  } catch (e) {
    res.status(500).json({ error: "search failed" });
  }
});

app.get("/api/categories", (req, res) =>
  res.json(["Política", "Geopolítica", "Análise"])
);

app.get("/api/premium", (req, res) => res.json(seedArticles));

app.get("/api/articles/:id", (req, res) => {
  const id = req.params.id;
  const all = [...seedArticles];

  const found = all.find(x => x.articleId === id);
  if (!found) return res.status(404).json({ error: "not found" });

  res.json(found);
});

app.post("/api/admin/refresh", async (req, res) => {
  const token = req.headers["x-admin-token"] || req.query.token || "";
  if (token !== ADMIN_TOKEN)
    return res.status(401).json({ error: "unauthorized" });

  try {
    cache.del("aggregated_news_v1");
    const data = await fetchAndAggregate();
    res.json({ ok: true, total: data.length, sample: data.slice(0, 8) });
  } catch (e) {
    console.error("admin refresh fail", e);
    res.status(500).json({ error: "refresh failed" });
  }
});

// START SERVER ============================
app.listen(PORT, () => {
  console.log(`RADAR backend listening on port ${PORT}`);
});
