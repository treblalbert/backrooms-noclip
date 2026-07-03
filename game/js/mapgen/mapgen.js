// Generación procedural de mapas por arquetipo de bioma.
// Tiles: 0 suelo · 1 pared · 2 vacío (abismo) · 3 agua · 4 suelo decorado
(function () {
  const T = { SUELO: 0, PARED: 1, VACIO: 2, AGUA: 3, DECOR: 4 };

  function grid(w, h, fill) {
    return { w, h, t: new Uint8Array(w * h).fill(fill) };
  }
  const at = (g, x, y) => (x < 0 || y < 0 || x >= g.w || y >= g.h ? T.PARED : g.t[y * g.w + x]);
  const set = (g, x, y, v) => { if (x >= 0 && y >= 0 && x < g.w && y < g.h) g.t[y * g.w + x] = v; };
  const walkable = (v) => v === T.SUELO || v === T.DECOR;

  // ---------- arquetipos ----------

  // Laberinto denso con salas abiertas (Level 0, 27, 130, 483...)
  // v11: se genera a 1/3 de resolución y se escala ×3 → pasillos de 3 huecos
  // (cabe un mueble de 1 tile y quedan 2 libres).
  function genPasillos(w, h, rng, opts = {}) {
    const hw = Math.ceil(w / 3), hh = Math.ceil(h / 3);
    const small = grid(hw, hh, T.PARED);
    const cw = Math.floor((hw - 1) / 2), ch = Math.floor((hh - 1) / 2);
    const seen = new Set();
    const stack = [[0, 0]];
    seen.add('0,0');
    set(small, 1, 1, T.SUELO);
    while (stack.length) {
      const [cx, cy] = stack[stack.length - 1];
      const dirs = rng.shuffle([[1, 0], [-1, 0], [0, 1], [0, -1]]);
      let moved = false;
      for (const [dx, dy] of dirs) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cw || ny >= ch || seen.has(nx + ',' + ny)) continue;
        seen.add(nx + ',' + ny);
        set(small, cx * 2 + 1 + dx, cy * 2 + 1 + dy, T.SUELO);
        set(small, nx * 2 + 1, ny * 2 + 1, T.SUELO);
        stack.push([nx, ny]);
        moved = true;
        break;
      }
      if (!moved) stack.pop();
    }
    // escala ×3 al tamaño real, con borde exterior de pared
    const g = grid(w, h, T.PARED);
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++)
        g.t[y * w + x] = small.t[((y / 3) | 0) * hw + ((x / 3) | 0)];
    // abre salas y atajos para que respire
    const salas = opts.salas ?? 8;
    for (let i = 0; i < salas; i++) {
      const rw = rng.int(3, 6), rh = rng.int(3, 5);
      const rx = rng.int(1, w - rw - 2), ry = rng.int(1, h - rh - 2);
      for (let y = ry; y < ry + rh; y++)
        for (let x = rx; x < rx + rw; x++) set(g, x, y, T.SUELO);
    }
    for (let i = 0; i < (opts.atajos ?? w); i++) {
      const x = rng.int(2, w - 3), y = rng.int(2, h - 3);
      if (at(g, x, y) === T.PARED &&
        ((walkable(at(g, x - 1, y)) && walkable(at(g, x + 1, y))) ||
         (walkable(at(g, x, y - 1)) && walkable(at(g, x, y + 1)))))
        if (rng.chance(0.4)) set(g, x, y, T.SUELO);
    }
    return g;
  }

  // Espacio abierto con pilares (Level 1)
  function genGaraje(w, h, rng) {
    const g = grid(w, h, T.SUELO);
    for (let x = 0; x < w; x++) { set(g, x, 0, T.PARED); set(g, x, h - 1, T.PARED); }
    for (let y = 0; y < h; y++) { set(g, 0, y, T.PARED); set(g, w - 1, y, T.PARED); }
    for (let y = 4; y < h - 4; y += rng.int(5, 7))
      for (let x = 4; x < w - 4; x += rng.int(5, 7)) {
        set(g, x, y, T.PARED); set(g, x + 1, y, T.PARED);
        set(g, x, y + 1, T.PARED); set(g, x + 1, y + 1, T.PARED);
      }
    // muros parciales y coches (decoración sólida)
    for (let i = 0; i < 10; i++) {
      const x = rng.int(4, w - 8), y = rng.int(4, h - 5), len = rng.int(3, 7);
      if (rng.chance(0.5)) for (let j = 0; j < len; j++) set(g, x + j, y, T.PARED);
      else for (let j = 0; j < len; j++) set(g, x, y + j, T.PARED);
    }
    for (let i = 0; i < 26; i++) set(g, rng.int(2, w - 3), rng.int(2, h - 3), T.DECOR);
    return g;
  }

  // Túneles serpenteantes (Level 2, 268, The Hub, L13) — v11: a 1/3 de
  // resolución escalado ×3 → túneles de 3 de ancho.
  function genTuneles(w, h, rng, opts = {}) {
    const hw = Math.ceil(w / 3), hh = Math.ceil(h / 3);
    const small = grid(hw, hh, T.PARED);
    let x = rng.int(2, hw - 3), y = rng.int(2, hh - 3);
    const walkers = opts.walkers ?? 5;
    for (let k = 0; k < walkers; k++) {
      let wx = x, wy = y, dir = rng.pick([[1, 0], [-1, 0], [0, 1], [0, -1]]);
      for (let i = 0; i < hw * 4; i++) {
        set(small, wx, wy, T.SUELO);
        if (rng.chance(0.22)) dir = rng.pick([[1, 0], [-1, 0], [0, 1], [0, -1]]);
        wx = Math.max(1, Math.min(hw - 2, wx + dir[0]));
        wy = Math.max(1, Math.min(hh - 2, wy + dir[1]));
      }
      const floors = collectFloors(small);
      const p = rng.pick(floors); x = p[0]; y = p[1];
    }
    const g = grid(w, h, T.PARED);
    for (let yy = 1; yy < h - 1; yy++)
      for (let xx = 1; xx < w - 1; xx++)
        g.t[yy * w + xx] = small.t[((yy / 3) | 0) * hw + ((xx / 3) | 0)];
    return g;
  }

  // Habitaciones BSP + corredores (hospitales, oficinas, hoteles)
  function genOficinas(w, h, rng) {
    const g = grid(w, h, T.PARED);
    const rooms = [];
    function split(x, y, rw, rh, depth) {
      if (depth <= 0 || (rw < 12 && rh < 12)) {
        const pw = rng.int(Math.max(4, rw - 6), rw - 2);
        const ph = rng.int(Math.max(3, rh - 6), rh - 2);
        const px = x + rng.int(1, Math.max(1, rw - pw - 1));
        const py = y + rng.int(1, Math.max(1, rh - ph - 1));
        rooms.push({ x: px, y: py, w: pw, h: ph });
        for (let yy = py; yy < py + ph; yy++)
          for (let xx = px; xx < px + pw; xx++) set(g, xx, yy, T.SUELO);
        return;
      }
      if (rw > rh) {
        const cut = rng.int(Math.floor(rw * 0.35), Math.floor(rw * 0.65));
        split(x, y, cut, rh, depth - 1);
        split(x + cut, y, rw - cut, rh, depth - 1);
      } else {
        const cut = rng.int(Math.floor(rh * 0.35), Math.floor(rh * 0.65));
        split(x, y, rw, cut, depth - 1);
        split(x, y + cut, rw, rh - cut, depth - 1);
      }
    }
    split(1, 1, w - 2, h - 2, 4);
    // conecta habitaciones consecutivas con pasillos en L de 2 de ancho (v11)
    for (let i = 1; i < rooms.length; i++) {
      const a = rooms[i - 1], b = rooms[i];
      let x1 = Math.floor(a.x + a.w / 2), y1 = Math.floor(a.y + a.h / 2);
      const x2 = Math.floor(b.x + b.w / 2), y2 = Math.floor(b.y + b.h / 2);
      while (x1 !== x2) { set(g, x1, y1, T.SUELO); set(g, x1, y1 + 1, T.SUELO); x1 += Math.sign(x2 - x1); }
      while (y1 !== y2) { set(g, x1, y1, T.SUELO); set(g, x1 + 1, y1, T.SUELO); y1 += Math.sign(y2 - y1); }
    }
    return g;
  }

  // Autómata celular: cuevas / exteriores (Level 6, 144, 909, 996)
  function genExterior(w, h, rng, opts = {}) {
    const g = grid(w, h, T.PARED);
    const density = opts.density ?? 0.44;
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++)
        if (!rng.chance(density)) set(g, x, y, T.SUELO);
    for (let it = 0; it < 4; it++) {
      const nt = new Uint8Array(g.t);
      for (let y = 1; y < h - 1; y++)
        for (let x = 1; x < w - 1; x++) {
          let walls = 0;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++)
              if (at(g, x + dx, y + dy) === T.PARED) walls++;
          nt[y * g.w + x] = walls >= 5 ? T.PARED : T.SUELO;
        }
      g.t = nt;
    }
    return g;
  }

  // Bosque: claros + arboledas + lagos (Level 45, 186, 626)
  function genBosque(w, h, rng, opts = {}) {
    const g = genExterior(w, h, rng, { density: 0.36 });
    if (opts.lagos) {
      for (let i = 0; i < opts.lagos; i++) {
        const cx = rng.int(6, w - 7), cy = rng.int(6, h - 7), r = rng.int(2, 4);
        for (let y = cy - r; y <= cy + r; y++)
          for (let x = cx - r; x <= cx + r; x++)
            if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r && at(g, x, y) === T.SUELO)
              set(g, x, y, T.AGUA);
      }
    }
    for (let i = 0; i < 30; i++) set(g, rng.int(2, w - 3), rng.int(2, h - 3), T.DECOR);
    return g;
  }

  // Ciudad: manzanas sólidas y calles (Level 306, 995)
  function genCiudad(w, h, rng) {
    const g = grid(w, h, T.SUELO);
    for (let x = 0; x < w; x++) { set(g, x, 0, T.PARED); set(g, x, h - 1, T.PARED); }
    for (let y = 0; y < h; y++) { set(g, 0, y, T.PARED); set(g, w - 1, y, T.PARED); }
    let y = 3;
    while (y < h - 6) {
      let x = 3;
      const bh = rng.int(4, 7);
      while (x < w - 6) {
        const bw = rng.int(4, 8);
        if (rng.chance(0.85))
          for (let yy = y; yy < Math.min(y + bh, h - 3); yy++)
            for (let xx = x; xx < Math.min(x + bw, w - 3); xx++) set(g, xx, yy, T.PARED);
        x += bw + rng.int(2, 3);
      }
      y += bh + rng.int(2, 3);
    }
    for (let i = 0; i < 24; i++) {
      const x = rng.int(2, w - 3), yy = rng.int(2, h - 3);
      if (at(g, x, yy) === T.SUELO) set(g, x, yy, T.DECOR);
    }
    return g;
  }

  // Torres: plataformas sobre el vacío unidas por vigas (Level 385)
  function genTorres(w, h, rng) {
    const g = grid(w, h, T.VACIO);
    const plats = [];
    const n = rng.int(9, 12);
    for (let i = 0; i < n; i++) {
      const pw = rng.int(5, 9), ph = rng.int(4, 7);
      const px = rng.int(2, w - pw - 3), py = rng.int(2, h - ph - 3);
      plats.push({ x: px, y: py, w: pw, h: ph });
      for (let y = py; y < py + ph; y++)
        for (let x = px; x < px + pw; x++) set(g, x, y, T.SUELO);
    }
    for (let i = 1; i < plats.length; i++) {
      const a = plats[i - 1], b = plats[i];
      let x1 = Math.floor(a.x + a.w / 2), y1 = Math.floor(a.y + a.h / 2);
      const x2 = Math.floor(b.x + b.w / 2), y2 = Math.floor(b.y + b.h / 2);
      while (x1 !== x2) { if (at(g, x1, y1) === T.VACIO) set(g, x1, y1, T.DECOR); x1 += Math.sign(x2 - x1); }
      while (y1 !== y2) { if (at(g, x1, y1) === T.VACIO) set(g, x1, y1, T.DECOR); y1 += Math.sign(y2 - y1); }
    }
    return g;
  }

  // ---------- utilidades comunes ----------

  function collectFloors(g) {
    const out = [];
    for (let y = 0; y < g.h; y++)
      for (let x = 0; x < g.w; x++)
        if (walkable(at(g, x, y))) out.push([x, y]);
    return out;
  }

  // conserva solo el mayor componente conexo de suelo
  function keepLargest(g) {
    const compOf = new Int32Array(g.w * g.h).fill(-1);
    let best = -1, bestSize = 0, comp = 0;
    for (let y = 0; y < g.h; y++)
      for (let x = 0; x < g.w; x++) {
        if (!walkable(at(g, x, y)) || compOf[y * g.w + x] !== -1) continue;
        let size = 0;
        const q = [[x, y]];
        compOf[y * g.w + x] = comp;
        while (q.length) {
          const [cx, cy] = q.pop();
          size++;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) continue;
            if (walkable(at(g, nx, ny)) && compOf[ny * g.w + nx] === -1) {
              compOf[ny * g.w + nx] = comp;
              q.push([nx, ny]);
            }
          }
        }
        if (size > bestSize) { bestSize = size; best = comp; }
        comp++;
      }
    for (let i = 0; i < g.t.length; i++)
      if (walkable(g.t[i]) && compOf[i] !== best)
        g.t[i] = g.t[i] === T.DECOR ? T.PARED : T.PARED;
    return g;
  }

  // distancias BFS desde un punto (para colocar salidas lejos del spawn)
  function bfsDist(g, sx, sy) {
    const d = new Int32Array(g.w * g.h).fill(-1);
    d[sy * g.w + sx] = 0;
    const q = [[sx, sy]];
    let head = 0;
    while (head < q.length) {
      const [cx, cy] = q[head++];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) continue;
        if (walkable(at(g, nx, ny)) && d[ny * g.w + nx] === -1) {
          d[ny * g.w + nx] = d[cy * g.w + cx] + 1;
          q.push([nx, ny]);
        }
      }
    }
    return d;
  }

  const GENS = {
    pasillos: (w, h, rng) => genPasillos(w, h, rng),
    garaje: (w, h, rng) => genGaraje(w, h, rng),
    tuneles: (w, h, rng) => genTuneles(w, h, rng, { ancho: true }),
    hospital: (w, h, rng) => genOficinas(w, h, rng),
    oficinas: (w, h, rng) => genOficinas(w, h, rng),
    exterior: (w, h, rng) => genExterior(w, h, rng),
    bosque: (w, h, rng, lv) => genBosque(w, h, rng, { lagos: (lv.reglas || []).includes('agua_traicionera') ? 5 : 2 }),
    ciudad: (w, h, rng) => genCiudad(w, h, rng),
    torres: (w, h, rng) => genTorres(w, h, rng),
  };

  // ---------- generación completa de un nivel ----------
  function generate(levelDef, rng) {
    const [w, h] = levelDef.tam;
    const gen = GENS[levelDef.bioma] ?? GENS.pasillos;
    let g = gen(w, h, rng, levelDef);
    keepLargest(g);
    let floors = collectFloors(g);
    if (floors.length < 60) { // mapa degenerado: reintenta con variante
      g = genPasillos(w, h, rng, { salas: 10 });
      keepLargest(g);
      floors = collectFloors(g);
    }

    const spawn = rng.pick(floors);
    const dist = bfsDist(g, spawn[0], spawn[1]);
    const reach = floors.filter(([x, y]) => dist[y * g.w + x] > 0);
    const far = reach.slice().sort((a, b) => dist[b[1] * g.w + b[0]] - dist[a[1] * g.w + a[0]]);

    // salidas: cada una en un punto lejano distinto; se prefieren casillas con
    // pared al norte para que las puertas queden pegadas a la pared
    const exits = [];
    const usable = (levelDef.salidas || []).filter((s) => s.tipo !== 'void');
    const farPool = far.slice(0, Math.max(usable.length * 8, 40));
    const shuffled = rng.shuffle(farPool);
    const spots = shuffled
      .filter(([x, y]) => at(g, x, y - 1) === T.PARED)
      .concat(shuffled.filter(([x, y]) => at(g, x, y - 1) !== T.PARED));
    usable.forEach((s, i) => {
      const p = spots[i % spots.length];
      if (p) exits.push({ x: p[0], y: p[1], def: s });
    });

    // objetos
    const items = [];
    for (const o of levelDef.objetos || []) {
      const n = rng.int(o.n[0], o.n[1]);
      for (let i = 0; i < n; i++) {
        const p = rng.pick(reach);
        items.push({ x: p[0], y: p[1], id: o.id });
      }
    }

    // props decorativos y contenedores registrables por bioma
    const PROPS_BIOMA = {
      pasillos: ['cable'], garaje: ['cono', 'bidon'], tuneles: ['bidon', 'cable'],
      hospital: ['camilla', 'silla'], oficinas: ['silla', 'caja'],
      bosque: ['seta', 'roca_p'], exterior: ['roca_p'], ciudad: ['farola'], torres: ['caja'],
    };
    const CONT_BIOMA = {
      pasillos: 'taquilla', garaje: 'taquilla', tuneles: 'cofre', hospital: 'nevera',
      oficinas: 'archivador', bosque: 'cofre', exterior: 'cofre', ciudad: 'cofre', torres: 'cofre',
    };
    const props = [];
    const exitKeys = new Set(exits.map((e) => e.y * g.w + e.x));
    const libre = (p) => !exitKeys.has(p[1] * g.w + p[0]);
    // los muebles "de pared" van físicamente pegados a un muro (pared al norte)
    const PROPS_PARED = new Set(['taquilla', 'archivador', 'nevera', 'reloj', 'camilla', 'farola']);
    const conParedNorte = reach.filter(([x, y]) => at(g, x, y - 1) === T.PARED);
    const sitioPara = (id) =>
      PROPS_PARED.has(id) && conParedNorte.length ? rng.pick(conParedNorte) : rng.pick(reach);
    const decorativos = PROPS_BIOMA[levelDef.bioma] ?? [];
    if (decorativos.length) {
      const n = rng.int(7, 13);
      for (let i = 0; i < n; i++) {
        const id = rng.pick(decorativos);
        const p = sitioPara(id);
        if (!libre(p)) continue;
        props.push({ x: p[0], y: p[1], id, contenedor: false });
      }
    }
    const nCont = rng.int(3, 5);
    for (let i = 0; i < nCont; i++) {
      const id = CONT_BIOMA[levelDef.bioma] ?? 'cofre';
      const p = sitioPara(id);
      if (!libre(p)) continue;
      props.push({ x: p[0], y: p[1], id, contenedor: true, registrado: false });
    }
    // el reloj es exclusivo de Level 80
    if (levelDef.id === 'level-80') {
      for (let i = 0; i < 6; i++) {
        const p = rng.pick(reach);
        props.push({ x: p[0], y: p[1], id: 'reloj', contenedor: false });
      }
    }

    // spawns de entidades (fieles a la ficha del nivel), lejos del jugador
    const entitySpawns = [];
    const midPool = reach.filter(([x, y]) => dist[y * g.w + x] >= 8);
    for (const e of levelDef.entidades || []) {
      if (!rng.chance(e.prob ?? 1)) continue;
      const n = rng.int(e.n[0], e.n[1]);
      for (let i = 0; i < n; i++) {
        const p = rng.pick(midPool.length ? midPool : reach);
        entitySpawns.push({ x: p[0], y: p[1], id: e.id });
      }
    }

    return { w, h, grid: g, spawn, exits, items, entitySpawns, props, dist };
  }

  window.MapGen = { T, generate, walkable, at, bfsDist };
})();
