/* Taste Genome engine: similarity, list GA, weight GA. Pure logic, no DOM, no network.
   Works on a Catalog of film objects, so the film data can come from anywhere (here: TMDB).

   A film is: { id, title, year, rating, q, director, genres[], cast[], themes[] }
     q is a 0..1 quality score. themes are keywords. */
(function (root) {
  'use strict';

  var GROUPS = ['Genre', 'Director', 'Cast', 'Themes', 'Era', 'Quality'];
  var INIT_W = [0.28, 0.14, 0.12, 0.24, 0.08, 0.14];

  function inter(a, b) { var n = 0; for (var i = 0; i < a.length; i++) if (b.indexOf(a[i]) >= 0) n++; return n; }
  function jac(a, b) { if (!a.length || !b.length) return 0; var k = inter(a, b); return k / (a.length + b.length - k); }
  function simVec(A, B) {
    return [
      A.genres.length && B.genres.length ? inter(A.genres, B.genres) / Math.sqrt(A.genres.length * B.genres.length) : 0,
      A.director && A.director === B.director ? 1 : 0,
      jac(A.cast, B.cast),
      jac(A.themes, B.themes),
      A.year && B.year ? Math.max(0, 1 - Math.abs(A.year - B.year) / 30) : 0
    ];
  }

  // A growing set of films with lazily cached pairwise similarity.
  function Catalog(opts) {
    this.films = []; this.index = new Map(); this.cache = new Map();
    opts = opts || {};   // wording and thresholds, so the same engine can rank books as well as films
    this.person = opts.person || 'director'; this.group = opts.group || 'Shares'; this.hiRating = opts.hiRating == null ? 8.0 : opts.hiRating; this.hiVotes = opts.hiVotes == null ? 1000 : opts.hiVotes;
  }
  Catalog.prototype.add = function (f) {
    if (this.index.has(f.id)) return this.index.get(f.id);
    var i = this.films.length; this.films.push(f); this.index.set(f.id, i); return i;
  };
  Catalog.prototype.idx = function (id) { return this.index.has(id) ? this.index.get(id) : -1; };
  Catalog.prototype.sims = function (a, b) {
    var k = a * 1048576 + b, v = this.cache.get(k);
    if (!v) {
      if (this.cache.size > 400000) this.cache.clear();   // bound memory on big catalogues
      v = simVec(this.films[a], this.films[b]); this.cache.set(k, v);
    }
    return v;
  };
  Catalog.prototype.sim = function (a, b, g) { return this.sims(a, b)[g]; };

  function mulberry32(s) {
    return function () {
      s |= 0; s = s + 0x6D2B79F5 | 0;
      var t = Math.imul(s ^ s >>> 15, 1 | s);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function gauss(rng) { return Math.sqrt(-2 * Math.log(rng() + 1e-12)) * Math.cos(2 * Math.PI * rng()); }
  function normW(w) {
    var s = 0, out = w.map(function (x) { var v = Math.abs(x) + 1e-6; s += v; return v; });
    return out.map(function (x) { return x / s; });
  }

  // Score every film against every profile film separately; a film's score is its best match.
  function scoreAll(C, profile, w, excluded, bias) {
    var N = C.films.length;
    var per = profile.map(function (s) {
      var row = new Float64Array(N);
      for (var f = 0; f < N; f++) {
        if (excluded.has(f)) { row[f] = -Infinity; continue; }
        var v = C.sims(s, f);
        row[f] = w[0] * v[0] + w[1] * v[1] + w[2] * v[2] + w[3] * v[3] + w[4] * v[4] + w[5] * C.films[f].q + (bias ? bias[f] : 0);
      }
      return row;
    });
    var score = new Float64Array(N), who = new Int32Array(N);
    for (var f2 = 0; f2 < N; f2++) {
      var best = -Infinity, bi = 0;
      for (var s2 = 0; s2 < per.length; s2++) if (per[s2][f2] > best) { best = per[s2][f2]; bi = s2; }
      score[f2] = best; who[f2] = bi;
    }
    return { per: per, score: score, who: who };
  }

  // List GA: random-key encoding, the n largest keys are the chosen films.
  // Fitness = relevance + variety + how well every profile film is covered.
  function listGA(C, cand, per, score, n, rng, o) {
    o = o || {};
    var K = cand.length;
    if (K <= n) return { picks: cand.slice(), curve: [] };
    var P = o.pop || 60, G = o.gens || 40, ld = o.lamDiv == null ? 0.3 : o.lamDiv, lc = o.lamCov == null ? 0.5 : o.lamCov;
    var sc = cand.map(function (f) { return score[f]; });
    var mn = Math.min.apply(null, sc), mx = Math.max.apply(null, sc);
    var r = sc.map(function (v) { return (v - mn) / (mx - mn || 1); });
    var psn = per.map(function (row) {
      var v = cand.map(function (f) { return row[f]; });
      var lo = Math.min.apply(null, v), hi = Math.max.apply(null, v);
      return v.map(function (x) { return (x - lo) / (hi - lo || 1); });
    });
    var D = new Float32Array(K * K);
    for (var i = 0; i < K; i++) for (var j = 0; j < K; j++)
      D[i * K + j] = i === j ? 0 : 0.5 * C.sim(cand[i], cand[j], 0) + 0.5 * C.sim(cand[i], cand[j], 3);

    function top(keys) {
      var idx = []; for (var i2 = 0; i2 < K; i2++) idx.push(i2);
      idx.sort(function (x, y) { return keys[y] - keys[x]; });
      return idx.slice(0, n);
    }
    function fit(idx) {
      var rel = 0, k, m, a1;
      for (k = 0; k < n; k++) rel += r[idx[k]];
      rel /= n;
      var ds = 0;
      for (k = 0; k < n; k++) for (m = 0; m < n; m++) if (k !== m) ds += D[idx[k] * K + idx[m]];
      var div = 1 - ds / (n * (n - 1));
      var cov = 0;
      for (a1 = 0; a1 < psn.length; a1++) {
        var best = 0; for (k = 0; k < n; k++) if (psn[a1][idx[k]] > best) best = psn[a1][idx[k]];
        cov += best;
      }
      cov /= psn.length;
      return rel + ld * div + lc * cov;
    }
    var pop = [];
    for (var p = 0; p < P; p++) pop.push(p === 0 ? r.slice() : r.map(function (x) { return x + gauss(rng) * 0.3; }));
    var curve = [], fits;
    for (var g = 0; g < G; g++) {
      fits = pop.map(function (kk) { return fit(top(kk)); });
      var order = fits.map(function (_, ix) { return ix; }).sort(function (x, y) { return fits[y] - fits[x]; });
      curve.push(fits[order[0]]);
      var next = [pop[order[0]], pop[order[1]]];
      var tour = function () {
        var b = Math.floor(rng() * P);
        for (var t = 0; t < 2; t++) { var c = Math.floor(rng() * P); if (fits[c] > fits[b]) b = c; }
        return pop[b];
      };
      while (next.length < P) {
        var p1 = tour(), p2 = tour(), child = new Array(K);
        for (var q = 0; q < K; q++) {
          child[q] = rng() < 0.5 ? p1[q] : p2[q];
          if (rng() < 0.1) child[q] += gauss(rng) * 0.1;
        }
        next.push(child);
      }
      pop = next;
    }
    fits = pop.map(function (kk) { return fit(top(kk)); });
    var bi = 0; for (var z = 1; z < P; z++) if (fits[z] > fits[bi]) bi = z;
    var chosen = top(pop[bi]).map(function (ix) { return cand[ix]; });
    chosen.sort(function (x, y) { return score[y] - score[x]; });
    return { picks: chosen, curve: curve };
  }

  // Human-readable reasons a film matches a given profile film.
  function explain(C, seed, f, w) {
    var A = C.films[seed], B = C.films[f], v = C.sims(seed, f), out = [], c = [];
    if (v[1] === 1) c.push([w[1] + 0.2, 'Same ' + C.person + ', ' + B.director]);
    var th = A.themes.filter(function (t) { return B.themes.indexOf(t) >= 0; });
    if (th.length) c.push([w[3] * v[3] + 0.05, 'Shared themes: ' + th.slice(0, 4).join(', ')]);
    var ge = A.genres.filter(function (t) { return B.genres.indexOf(t) >= 0; });
    if (ge.length) c.push([w[0] * v[0], 'Genre overlap: ' + ge.join(', ')]);
    var ca = A.cast.filter(function (t) { return B.cast.indexOf(t) >= 0; });
    if (ca.length) c.push([w[2] * v[2] + 0.1, C.group + ' ' + ca.slice(0, 2).join(' and ')]);
    if (v[4] > 0.75) c.push([w[4] * v[4] * 0.5, 'Same era (' + B.year + ')']);
    if (B.rating >= C.hiRating && B.votes >= C.hiVotes) c.push([w[5] * B.q * 0.5, 'Very highly rated (' + B.rating.toFixed(1) + ')']);
    c.sort(function (x, y) { return y[0] - x[0]; });
    for (var i = 0; i < c.length && out.length < 3; i++) out.push(c[i][1]);
    return out;
  }

  // One recommendation round: 10 films = (10 - wild) GA-balanced picks plus `wild` exploration wildcards (default 2, max 4).
  // profile and excluded use catalog indices. Returned items use catalog indices too.
  function recommend(C, profile, w, excluded, rng, o) {
    o = o || {};
    var N = C.films.length;
    var g = Math.max(0, Math.min(1, o.gems || 0)), bias = null;
    if (g > 0) {        // "hidden gems": judge quality by the raw rating, mark down very popular titles, and drop the most-voted ones outright
      var votes = C.films.map(function (m) { return m.votes || 0; }), mx = 1;
      for (var vi = 0; vi < N; vi++) if (votes[vi] > mx) mx = votes[vi];
      var lmx = Math.log(1 + mx);
      bias = new Float64Array(N);
      for (var bi2 = 0; bi2 < N; bi2++) {
        var m0 = C.films[bi2], rq = m0.rq != null ? m0.rq : Math.max(0, Math.min(1, ((m0.rating || 0) - 6.5) / 2.8));
        bias[bi2] = g * (w[5] * (rq - m0.q) - 0.5 * Math.log(1 + votes[bi2]) / lmx);
      }
      if (g > 0.25) {
        var sorted = votes.slice().sort(function (a, b) { return b - a; }), cut = sorted[Math.min(N - 1, Math.floor(N * 0.6 * g))];
        excluded = new Set(excluded);
        for (var ei = 0; ei < N; ei++) if (votes[ei] > cut) excluded.add(ei);
      }
    }
    var sc = scoreAll(C, profile, w, excluded, bias);
    var idx = []; for (var f = 0; f < N; f++) if (sc.score[f] > -Infinity) idx.push(f);
    idx.sort(function (x, y) { return sc.score[y] - sc.score[x]; });
    var wild = o.wild == null ? 2 : Math.max(0, Math.min(4, Math.round(o.wild)));
    var cand = idx.slice(0, o.K || 40), nGA = 10 - wild, ga = null, picks;
    if (o.useGA === false) { picks = cand.slice(0, nGA); }
    else { ga = listGA(C, cand, sc.per, sc.score, nGA, rng, o); picks = ga.picks; }
    var items = picks.map(function (f2) {
      return { id: f2, wildcard: false, seed: profile[sc.who[f2]], why: explain(C, profile[sc.who[f2]], f2, w) };
    });
    // wildcards: stretch picks from the mid-ranked, well-regarded films
    var minR = o.minRating == null ? 7.0 : o.minRating, minV = o.minVotes == null ? 500 : o.minVotes;
    if (g > 0) minV = Math.min(minV, Math.round(minV * (1 - 0.7 * g)));
    var okFilm = function (f3) { var m = C.films[f3]; return picks.indexOf(f3) < 0 && m.rating >= minR && m.votes >= minV; };
    var pool = idx.slice(40, 130).filter(okFilm);
    if (pool.length < 2) pool = idx.slice(10).filter(okFilm);
    for (var k = 0; k < wild && pool.length; k++) {
      var wi = Math.floor(rng() * pool.length), wf = pool.splice(wi, 1)[0];
      var pos = 3 + Math.floor(rng() * Math.max(1, Math.min(7 + k, items.length - 2)));
      items.splice(Math.min(pos, items.length), 0, {
        id: wf, wildcard: true, seed: profile[sc.who[wf]],
        why: ['Wildcard: outside your usual lane, included to learn what else you like']
      });
    }
    return { items: items, curve: ga ? ga.curve : [] };
  }

  // What the liked and rejected films have in common: counts per genre, director and decade.
  // liked / rejected are catalog indices. The UI turns the counts into shares.
  function taste(C, liked, rejected) {
    function tally(list) {
      var g = {}, d = {}, e = {};
      list.forEach(function (i) {
        var f = C.films[i]; if (!f) return;
        f.genres.forEach(function (x) { g[x] = (g[x] || 0) + 1; });
        if (f.director) d[f.director] = (d[f.director] || 0) + 1;
        if (f.year) { var dec = Math.floor(f.year / 10) * 10; e[dec] = (e[dec] || 0) + 1; }
      });
      return { genres: g, directors: d, eras: e, n: list.length };
    }
    return { liked: tally(liked), rejected: tally(rejected) };
  }

  // ---- learning from ratings -------------------------------------------------
  // A log item is self-contained: { sims: [[5 group sims per profile film]], q, label: 1|0, wt }
  function makeItem(C, profile, f, label, wt) {
    return { sims: profile.map(function (s) { return C.sims(s, f).slice(); }), q: C.films[f].q, label: label, wt: wt };
  }
  function itemScore(it, w) {
    var best = -Infinity;
    for (var s = 0; s < it.sims.length; s++) {
      var v = w[0] * it.sims[s][0] + w[1] * it.sims[s][1] + w[2] * it.sims[s][2] + w[3] * it.sims[s][3] + w[4] * it.sims[s][4];
      if (v > best) best = v;
    }
    return best + w[5] * it.q;
  }
  // Pairwise win rate: how often a film the viewer loved outscores one they rejected.
  function fitness(items, w) {
    var pos = [], neg = [], i, j;
    for (i = 0; i < items.length; i++) {
      var sc = itemScore(items[i], w);
      (items[i].label === 1 ? pos : neg).push([sc, items[i].wt]);
    }
    var num = 0, den = 0;
    for (i = 0; i < pos.length; i++) for (j = 0; j < neg.length; j++) {
      var pw = pos[i][1] * neg[j][1];
      den += pw;
      num += pw * (pos[i][0] > neg[j][0] ? 1 : pos[i][0] === neg[j][0] ? 0.5 : 0);
    }
    return den ? num / den : 0.5;
  }
  function l1(a, b) { var s = 0; for (var i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s; }

  function evolveWeights(items, champion, rng, o) {
    o = o || {};
    var P = o.pop || 40, G = o.gens || 40, lam = o.lambda == null ? 0.05 : o.lambda;
    var pop = [champion.slice()], i;
    for (i = 1; i < P; i++) {
      if (i < P / 2) pop.push(normW(champion.map(function (x) { return x + gauss(rng) * 0.08; })));
      else pop.push(normW(champion.map(function () { return -Math.log(rng() + 1e-9); })));
    }
    var curve = [], fits;
    var F = function (w) { return fitness(items, w) - lam * l1(w, champion); };   // gentle pull toward current weights
    for (var g = 0; g < G; g++) {
      fits = pop.map(F);
      var order = fits.map(function (_, ix) { return ix; }).sort(function (x, y) { return fits[y] - fits[x]; });
      curve.push(fitness(items, pop[order[0]]));
      var next = [pop[order[0]], pop[order[1]]];
      var tour = function () {
        var b = Math.floor(rng() * P);
        for (var t = 0; t < 2; t++) { var c = Math.floor(rng() * P); if (fits[c] > fits[b]) b = c; }
        return pop[b];
      };
      while (next.length < P) {
        var p1 = tour(), p2 = tour();
        var child = p1.map(function (x, k) {
          var a = -0.25 + 1.5 * rng(), v = a * x + (1 - a) * p2[k];
          if (rng() < 0.25) v += gauss(rng) * 0.06;
          return Math.max(0, v);
        });
        next.push(normW(child));
      }
      pop = next;
    }
    fits = pop.map(F);
    var bi = 0; for (i = 1; i < P; i++) if (fits[i] > fits[bi]) bi = i;
    return { best: pop[bi], curve: curve };
  }

  // Decide whether to adopt evolved weights using 4-fold cross-validation: evolve on 3 folds, score on the
  // held-out fold, and require the evolved weights to beat the current ones on average.
  // Besides the viewer's explicit ratings, random unseen films are added as light negatives, so a loved
  // film is compared with the whole catalog and not only with the near-misses we chose to show.
  // ctx = { C: catalog, profile: [indices], exclude: Set of indices never sampled as negatives }
  function evolve(items, ctx, champion, rng, o) {
    var nPos = 0, nNeg = 0;
    items.forEach(function (it) { if (it.label === 1) nPos++; else nNeg++; });
    if (items.length < 12 || nPos < 3 || nNeg < 3) {
      return { ok: false, need: Math.max(12 - items.length, 0), msg: 'Rate a few more films (at least 12 ratings, with some loved and some rejected) before the weights can evolve.' };
    }
    var all = items.slice(), pool = [], f;
    for (f = 0; f < ctx.C.films.length; f++) if (!ctx.exclude.has(f)) pool.push(f);
    for (var s = 0; s < 70 && pool.length; s++) {
      var pi = Math.floor(rng() * pool.length), nf = pool.splice(pi, 1)[0];
      all.push(makeItem(ctx.C, ctx.profile, nf, 0, 0.12));
    }
    var K = 4, folds = [], tries = 0;
    while (tries++ < 25) {
      var idx = all.map(function (_, i) { return i; });
      for (var i = idx.length - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)); var t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
      folds = [];
      for (var k = 0; k < K; k++) {
        var val = [], train = [];
        idx.forEach(function (ix, pos) { (pos % K === k ? val : train).push(all[ix]); });
        var vp = val.filter(function (x) { return x.label === 1; }).length;
        var tp = train.filter(function (x) { return x.label === 1; }).length;
        if (vp >= 1 && val.length - vp >= 1 && tp >= 2 && train.length - tp >= 2) folds.push({ train: train, val: val });
      }
      if (folds.length === K) break;
    }
    if (folds.length < 2) return { ok: false, need: 0, msg: 'Ratings are too lopsided to validate. Rate a mix of loved and rejected films.' };
    var sumNew = 0, sumOld = 0;
    folds.forEach(function (fd) {
      var res = evolveWeights(fd.train, champion, rng, { pop: 30, gens: 30 });
      sumNew += fitness(fd.val, res.best); sumOld += fitness(fd.val, champion);
    });
    var vNew = sumNew / folds.length, vOld = sumOld / folds.length;
    var full = evolveWeights(all, champion, rng, o);
    var promoted = vNew > vOld + 0.005;
    return {
      ok: true, promoted: promoted, weights: promoted ? full.best : champion, challenger: full.best, curve: full.curve,
      valNew: vNew, valOld: vOld, folds: folds.length, trainOld: fitness(all, champion), trainNew: fitness(all, full.best), n: items.length
    };
  }

  root.Engine = {
    GROUPS: GROUPS, INIT_W: INIT_W, Catalog: Catalog, mulberry32: mulberry32, normW: normW,
    recommend: recommend, taste: taste, explain: explain, makeItem: makeItem, evolve: evolve, fitness: fitness, scoreAll: scoreAll
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.Engine;
})(typeof window !== 'undefined' ? window : globalThis);
