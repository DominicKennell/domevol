'use strict';
/* TMDB client core shared by the Node server and the browser (direct mode). No Node-only APIs.
   Docs: https://developer.themoviedb.org/reference/intro/getting-started */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TmdbCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
const DAY = 864e5;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

const KINDS = {
  movie: { date: 'release_date', title: 'title' },
  tv: { date: 'first_air_date', title: 'name' },
};
const kindOf = (k) => (k === 'tv' ? 'tv' : 'movie');

// Streaming services the app links to. TMDB's watch-provider data (from JustWatch) is reduced to these.
const PLATFORMS = {
  netflix: /^netflix/i, disney: /^disney/i, apple: /^apple tv/i, prime: /^amazon (prime )?video/i,
  google: /^google play/i, youtube: /^youtube/i,
};

/** { GB: { netflix: 's', apple: 'rb' } }  s = stream (incl. free/ads), r = rent, b = buy. null = no data at all. */
function compactProviders(wp) {
  const res = wp && wp.results;
  if (!res || typeof res !== 'object') return null;
  const out = {};
  for (const [cc, r] of Object.entries(res)) {
    const row = {};
    for (const [key, re] of Object.entries(PLATFORMS)) {
      const has = (k) => (r[k] || []).some((p) => re.test(p.provider_name || ''));
      const m = (has('flatrate') || has('free') || has('ads') ? 's' : '') + (has('rent') ? 'r' : '') + (has('buy') ? 'b' : '');
      if (m) row[key] = m;
    }
    if (Object.keys(row).length) out[cc] = row;
  }
  return out;
}

function pickTrailer(videos) {
  const v = ((videos && videos.results) || []).filter((x) => x.site === 'YouTube' && x.key);
  const t = v.find((x) => x.type === 'Trailer' && x.official) || v.find((x) => x.type === 'Trailer') || v.find((x) => x.type === 'Teaser');
  return t ? t.key : null;
}

/** Turn a TMDB details response (credits, keywords, videos and watch/providers appended) into the engine's film shape.
 *  Works for films and TV shows; for TV the "director" is the show's creator. */
function normalize(d, kind) {
  kind = kindOf(kind);
  const K = KINDS[kind];
  const crew = (d.credits && d.credits.crew) || [];
  const dir = kind === 'tv' ? ((d.created_by || [])[0] || null) : (crew.find((c) => c.job === 'Director') || null);
  const cast = ((d.credits && d.credits.cast) || []).slice(0, 5).map((c) => c.name);
  const kwRaw = d.keywords ? (kind === 'tv' ? d.keywords.results : d.keywords.keywords) : [];
  const kws = (kwRaw || []).slice(0, 15);
  const R = Number(d.vote_average) || 0;
  const v = Number(d.vote_count) || 0;
  const adj = (v * R + 500 * 6.6) / (v + 500);          // shrink scores with few votes toward the average
  const runtime = kind === 'tv'
    ? ((d.episode_run_time || [])[0] || (d.last_episode_to_air && d.last_episode_to_air.runtime) || 0)
    : (d.runtime || 0);
  return {
    id: d.id,
    kind,
    title: d[K.title] || d.original_title || d.original_name || 'Untitled',
    year: parseInt((d[K.date] || '').slice(0, 4), 10) || 0,
    rating: Math.round(R * 10) / 10,
    votes: v,
    q: clamp((adj - 6.5) / 2.8, 0, 1),
    director: dir ? dir.name : '',
    genres: (d.genres || []).map((g) => g.name),
    cast,
    themes: kws.map((k) => k.name),
    poster: d.poster_path || null,
    backdrop: d.backdrop_path || null,
    overview: (d.overview || '').slice(0, 320),
    runtime,
    seasons: kind === 'tv' ? (d.number_of_seasons || 0) : 0,
    trailer: pickTrailer(d.videos),
    p: compactProviders(d['watch/providers']),
    _directorId: dir ? dir.id : null,
    _genreIds: (d.genres || []).map((g) => g.id),
    _kwIds: kws.map((k) => k.id),
  };
}
const publicFilm = (f) => Object.fromEntries(Object.entries(f).filter(([k]) => k[0] !== '_'));

class TmdbError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

class TmdbCore {
  /** opts: { key | token, base, cachePath, concurrency, fetchImpl } */
  constructor(opts = {}) {
    this.base = (opts.base || 'https://api.themoviedb.org/3').replace(/\/$/, '');
    this.key = opts.key || '';
    this.token = opts.token || '';
    this.max = opts.concurrency || 8;
    this.fetch = opts.fetchImpl || ((...a) => globalThis.fetch(...a));
    this.active = 0;
    this.queue = [];
    this.inflight = new Map();
    this.cache = new Map();
    this.saveTimer = null;
  }

  get configured() { return !!(this.key || this.token); }

  scheduleSave() { /* override to persist */ }
  flush() { /* override to persist */ }

  _limited(fn) {
    return new Promise((resolve, reject) => {
      const run = () => {
        this.active++;
        fn().then(resolve, reject).finally(() => {
          this.active--;
          const next = this.queue.shift();
          if (next) next();
        });
      };
      if (this.active < this.max) run(); else this.queue.push(run);
    });
  }

  async _request(path, params) {
    if (!this.configured) throw new TmdbError('No TMDB API key configured.', 401);
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const headers = { accept: 'application/json' };
    if (this.token) headers.authorization = 'Bearer ' + this.token; else url.searchParams.set('api_key', this.key);
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 15000);
        let res;
        try { res = await this.fetch(url, { headers, signal: ctl.signal }); } finally { clearTimeout(timer); }
        if (res.status === 401) throw new TmdbError('TMDB rejected the API key (401). Check your TMDB key.', 401);
        if (res.status === 404) throw new TmdbError('Not found on TMDB (404).', 404);
        if (res.status === 429 || res.status >= 500) {
          const wait = Number(res.headers.get('retry-after')) * 1000 || 400 * 2 ** attempt;
          lastErr = new TmdbError('TMDB returned ' + res.status + '.', res.status);
          await new Promise((r) => setTimeout(r, Math.min(wait, 5000)));
          continue;
        }
        if (!res.ok) throw new TmdbError('TMDB returned ' + res.status + '.', res.status);
        return await res.json();
      } catch (e) {
        if (e instanceof TmdbError && (e.status === 401 || e.status === 404 || (e.status && e.status < 500 && e.status !== 429))) throw e;
        lastErr = e instanceof TmdbError ? e : new TmdbError('Could not reach TMDB: ' + (e.message || e), 502);
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
      }
    }
    throw lastErr;
  }

  /** Cache anything JSON-serialisable under a key. Concurrent callers share one request. */
  async cached(key, ttl, producer) {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.t < ttl) return hit.d;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = this._limited(producer)
      .then((d) => { this.cache.set(key, { t: Date.now(), d }); this.scheduleSave(); return d; })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  async search(q, kind) {
    kind = kindOf(kind);
    const K = KINDS[kind];
    const query = String(q).trim().slice(0, 100);
    if (!query) return [];
    return this.cached(`search:${kind}:` + query.toLowerCase(), DAY, async () => {
      const d = await this._request('/search/' + kind, { query, include_adult: 'false', page: 1 });
      return (d.results || []).filter((r) => r[K.date] && !r.adult).slice(0, 8).map((r) => ({
        id: r.id, kind, title: r[K.title], year: parseInt(r[K.date].slice(0, 4), 10) || 0,
        rating: Math.round((r.vote_average || 0) * 10) / 10, votes: r.vote_count || 0, poster: r.poster_path || null,
      }));
    });
  }

  /** Full normalised title. One TMDB call returns details, credits, keywords, trailers and availability. Cached 30 days. */
  async details(id, kind) {
    kind = kindOf(kind);
    const n = parseInt(id, 10);
    if (!Number.isInteger(n) || n <= 0) throw new TmdbError('Invalid id.', 400);
    return this.cached(`film2:${kind}:${n}`, 30 * DAY, async () => normalize(await this._request(`/${kind}/${n}`, {
      append_to_response: 'credits,keywords,videos,watch/providers', include_video_language: 'en,null',
    }), kind));
  }

  /** A list endpoint reduced to ids. */
  listIds(path, params, kind) {
    const K = KINDS[kindOf(kind)];
    const key = 'list:' + path + '?' + Object.entries(params).sort().map(([k, v]) => k + '=' + v).join('&');
    return this.cached(key, DAY, async () => {
      const d = await this._request(path, params);
      return (d.results || []).filter((r) => r[K.date] && !r.adult).map((r) => r.id);
    });
  }

  /**
   * Build a candidate pool around the seed films: TMDB's own recommendations and similar films, more films by
   * the same directors, same-genre and same-keyword popular films, plus a few acclaimed films for wildcards.
   * Lists are interleaved so every seed is represented before the cap is reached.
   */
  async pool(seedIds, opts = {}) {
    const kind = kindOf(opts.kind);
    const cap = opts.cap || 260;
    const T = kind === 'tv' ? { genre: 100, kw: 50, top: 1000 } : { genre: 500, kw: 300, top: 5000 };   // TV shows get fewer votes
    const seeds = await Promise.all(seedIds.map((id) => this.details(id, kind)));
    const jobs = [];
    for (const s of seeds) {
      jobs.push(this.listIds(`/${kind}/${s.id}/recommendations`, { page: 1 }, kind));
      jobs.push(this.listIds(`/${kind}/${s.id}/recommendations`, { page: 2 }, kind));
      jobs.push(this.listIds(`/${kind}/${s.id}/similar`, { page: 1 }, kind));
      if (kind === 'movie' && s._directorId) jobs.push(this.listIds('/discover/movie', { with_crew: s._directorId, sort_by: 'vote_count.desc', page: 1 }, kind));
      if (s._genreIds.length) jobs.push(this.listIds('/discover/' + kind, { with_genres: s._genreIds.slice(0, 2).join(','), sort_by: 'popularity.desc', 'vote_count.gte': T.genre, page: 1 }, kind));
      if (s._kwIds.length) jobs.push(this.listIds('/discover/' + kind, { with_keywords: s._kwIds.slice(0, 3).join('|'), sort_by: 'popularity.desc', 'vote_count.gte': T.kw, page: 1 }, kind));
    }
    for (let p = 1; p <= 3; p++) jobs.push(this.listIds('/discover/' + kind, { sort_by: 'vote_average.desc', 'vote_count.gte': T.top, page: p }, kind));
    let firstErr = null;
    const lists = await Promise.all(jobs.map((j) => j.catch((e) => { firstErr = firstErr || e; return []; })));
    if (!lists.some((l) => l.length) && firstErr) throw firstErr;

    const ids = new Set(seedIds.map(Number));
    for (let i = 0; ids.size < cap; i++) {
      let any = false;
      for (const l of lists) if (i < l.length) { any = true; ids.add(l[i]); if (ids.size >= cap) break; }
      if (!any) break;
    }
    const settled = await Promise.allSettled([...ids].map((id) => this.details(id, kind)));
    const films = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value).filter((f) => f.year > 0 && f.genres.length);
    if (!films.length && settled.length) throw settled.find((r) => r.status === 'rejected').reason;
    this.flush();
    return films;
  }
}

return { TmdbCore, TmdbError, normalize, publicFilm, compactProviders, kindOf, pickTrailer, KINDS, PLATFORMS };
}));
