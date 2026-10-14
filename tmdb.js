'use strict';
/* Node TMDB client: the shared core plus an on-disk cache. */
const fs = require('fs');
const core = require('./tmdb-core.js');

class Tmdb extends core.TmdbCore {
  constructor(opts = {}) {
    super(opts);
    this.cachePath = opts.cachePath || null;
    this.saveTimer = null;
    this.loadCache();
  }
  loadCache() {
    if (!this.cachePath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      for (const [k, v] of Object.entries(raw)) if (!k.startsWith('film:')) this.cache.set(k, v);   // 'film:' = old schema
    } catch (e) { /* no cache yet */ }
  }
  scheduleSave() {
    if (!this.cachePath || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        const tmp = this.cachePath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.cache)));
        fs.renameSync(tmp, this.cachePath);
      } catch (e) { /* cache is optional */ }
    }, 1500);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }
  flush() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (!this.cachePath) return;
    try { fs.writeFileSync(this.cachePath, JSON.stringify(Object.fromEntries(this.cache))); } catch (e) { /* ignore */ }
  }
}

module.exports = { Tmdb, TmdbError: core.TmdbError, normalize: core.normalize, publicFilm: core.publicFilm, compactProviders: core.compactProviders, kindOf: core.kindOf };
