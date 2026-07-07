// Una SALA = una instancia viva de un nivel («level-0::1»). Censo de jugadores,
// entidades simuladas (sim/entidades.js), objetos del suelo, salidas con
// mecánica (romper pared/suelo con canal + dado) y escondites. Los jugadores
// NO se bloquean entre sí; las entidades sí ocupan casilla.
'use strict';

const { DATA, RNG, MapGen, generarMapa, esTransitable } = require('./sim/mundo');
const Entidades = require('./sim/entidades');
const P = require('./protocolo');
const db = require('./db');

let siguienteId = 1;
const ESCONDITES = new Set(['taquilla', 'nevera', 'archivador']);

class Sala {
  constructor(nivelId, inst) {
    this.nivelId = nivelId;
    this.inst = inst;
    this.clave = `${nivelId}::${inst}`;
    // La semilla es el contrato con el cliente: mismo string → mismo mapa.
    this.semilla = `mmo::${nivelId}::${inst}`;
    const { def, map } = generarMapa(nivelId, this.semilla);
    this.def = def;
    this.map = map;
    this.jugadores = new Map();
    this.rng = RNG.create(this.semilla + '::sim'); // dados y azar de la sala
    this.entidades = Entidades.crear(map, DATA.entities, RNG.create(this.semilla + '::ents'));
    this.ruido = null;
    this.alCruzar = null; // lo inyecta server.js (cambio de sala)
    this.alMorir = null;  // ídem (respawn en Level 0)
  }

  get llena() { return this.jugadores.size >= P.CAP_SALA; }

  ocupada(x, y) {
    for (const j of this.jugadores.values()) if (j.x === x && j.y === y) return true;
    return false;
  }

  buscarSpawn() {
    const [sx, sy] = this.map.spawn;
    for (let r = 0; r < 20; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = sx + dx, y = sy + dy;
          if (esTransitable(this.map, x, y) && !this.ocupada(x, y)) return [x, y];
        }
    return [sx, sy];
  }

  censo() {
    return [...this.jugadores.values()].map((j) => ({
      id: j.id, nombre: j.nombre, x: j.x, y: j.y, rot: j.rot,
      escondido: !!j.escondido,
    }));
  }

  // estado de sala que el cliente no puede derivar de la semilla
  estadoDinamico() {
    return {
      ents: this.entidades.map((e) => ({
        uid: e.uid, id: e.id, x: e.x, y: e.y, viva: e.viva, revelada: e.revelada,
      })),
      itemsTomados: this.map.items.map((it, i) => it.taken ? i : -1).filter((i) => i >= 0),
      abiertas: this.map.exits.map((ex, i) => ex.def._abierta ? i : -1).filter((i) => i >= 0),
    };
  }

  entrar(ws, nombre, token, expediente) {
    const id = siguienteId++;
    const [x, y] = this.buscarSpawn();
    const jug = {
      id, ws, nombre, token, x, y, rot: 2,
      salud: 100, luz: false, escondido: null, muerto: false,
      inv: [], manos: [null, null],
      sintonia: expediente ? expediente.sintonia : 0,
      esAdmin: false, muteadoHasta: 0,
      ultMov: 0, ultChat: 0, canal: null, ofertaEn: null,
    };
    this.prepararCaminata(jug);
    this.enviar(ws, {
      t: 'bienvenida', id, nivel: this.nivelId, inst: this.inst,
      semilla: this.semilla, x, y, rot: jug.rot,
      salud: jug.salud, inv: jug.inv, manos: jug.manos,
      sintonia: jug.sintonia,
      caminata: jug.caminataObjetivo ? { pasos: 0, objetivo: jug.caminataObjetivo } : null,
      jugadores: this.censo(), ...this.estadoDinamico(),
    });
    this.difundir({ t: 'entra', id, nombre, x, y, rot: jug.rot });
    this.jugadores.set(id, jug);
    return jug;
  }

  // La caminata online es PERSONAL: tus pasos reales en el nivel te van
  // desintonizando hasta que TÚ haces no-clip al destino (el nivel no puede
  // «ceder» para 60 personas a la vez). El objetivo sale de tu token: cada
  // errante recorre su propia distancia.
  prepararCaminata(jug) {
    jug.pasosSala = 0;
    jug.caminataObjetivo = (this.map.caminatas || []).length
      ? MapGen.walkingGoal(this.def, `${jug.token}::${this.clave}`, 1, 0)
      : 0;
  }

  // sube la Sintonía (0-100): presenciar horrores te acompasa con el lugar
  tune(jug, n) {
    jug.sintonia = Math.max(0, Math.min(100, (jug.sintonia || 0) + n));
    db.guardarSintonia(jug.token, jug.sintonia);
    this.enviar(jug.ws, { t: 'sintonia', v: jug.sintonia });
  }

  salir(jug) {
    if (!this.jugadores.delete(jug.id)) return;
    this.difundir({ t: 'sale', id: jug.id });
  }

  // ---------- movimiento ----------
  mover(jug, dx, dy) {
    const ahora = Date.now();
    if (jug.muerto) return;
    if (ahora - jug.ultMov < P.COOLDOWN_MOVER) return;
    if (jug.canal) this.cancelarCanal(jug, 'Te mueves: dejas lo que estabas haciendo.');
    if (jug.escondido) this.esconder(jug, false);
    const nx = jug.x + dx, ny = jug.y + dy;
    if (esTransitable(this.map, nx, ny)) {
      jug.x = nx; jug.y = ny; jug.ultMov = ahora;
      this.difundir({ t: 'mueve', id: jug.id, x: nx, y: ny });
      this.pisar(jug);
      this.pasoCaminata(jug);
    } else {
      this.enviar(jug.ws, { t: 'mueve', id: jug.id, x: jug.x, y: jug.y });
    }
  }

  // progreso de la caminata personal: aviso periódico al cliente (que pinta el
  // fundido gris y los bocadillos) y cruce AUTOMÁTICO al llegar al objetivo
  pasoCaminata(jug) {
    if (!jug.caminataObjetivo || jug.muerto) return;
    jug.pasosSala++;
    if (jug.pasosSala % 20 === 0 || jug.pasosSala === jug.caminataObjetivo)
      this.enviar(jug.ws, { t: 'caminata', pasos: jug.pasosSala, objetivo: jug.caminataObjetivo });
    if (jug.pasosSala >= jug.caminataObjetivo) {
      const defC = this.map.caminatas[0];
      if (!defC) return;
      this.tune(jug, 3);
      if (this.alCruzar) this.alCruzar(jug, this, defC, { sinTarjeta: true });
    }
  }

  // efectos de pisar una casilla: recoger objeto, oferta de salida
  pisar(jug) {
    const i = this.map.items.findIndex((it) => !it.taken && it.x === jug.x && it.y === jug.y);
    if (i >= 0 && jug.inv.length < 6) {
      const it = this.map.items[i];
      it.taken = true;
      jug.inv.push(it.id);
      // tubería o linterna a una mano libre: lista para usar
      const m = jug.manos.indexOf(null);
      if (m >= 0 && (it.id === 'tuberia' || it.id === 'linterna')) {
        jug.manos[m] = it.id;
        jug.inv.pop();
      }
      this.difundir({ t: 'itemCogido', idx: i, por: jug.id, id: it.id });
      this.enviar(jug.ws, { t: 'inv', inv: jug.inv, manos: jug.manos });
    }
    const ex = this.salidaEn(jug.x, jug.y);
    if (ex && jug.ofertaEn !== ex.i) this.ofrecer(jug, ex);
    if (!ex) jug.ofertaEn = null;
  }

  salidaEn(x, y) {
    const i = this.map.exits.findIndex((e) => e.x === x && e.y === y);
    return i >= 0 ? { i, ex: this.map.exits[i] } : null;
  }

  ofrecer(jug, { i, ex }) {
    jug.ofertaEn = i;
    const def = ex.def;
    if ((def._mec === 'romper' || def._mec === 'romper_suelo') && !def._abierta) {
      this.enviar(jug.ws, {
        t: 'aviso',
        txt: def._mec === 'romper_suelo'
          ? 'El suelo CRUJE bajo la moqueta. Pulsa ESPACIO para intentar romperlo.'
          : 'Esta pared está AGRIETADA: suena hueca. Pulsa ESPACIO para intentar abrirla.',
      });
      return;
    }
    this.enviar(jug.ws, { t: 'oferta', i, texto: def.texto, destino: def.destino, tipo: def.tipo });
  }

  // ---------- ESPACIO contextual ----------
  accion(jug) {
    if (jug.muerto || jug.canal) return;
    // 1) escondite: sobre un mueble escondible (o salir de él)
    if (jug.escondido) { this.esconder(jug, false); return; }
    const prop = (this.map.props || []).find(
      (p) => ESCONDITES.has(p.id) && Math.abs(p.x - jug.x) + Math.abs(p.y - jug.y) <= 1
    );
    // 2) salida con mecánica de romper
    const s = this.salidaEn(jug.x, jug.y);
    if (s && (s.ex.def._mec === 'romper' || s.ex.def._mec === 'romper_suelo') && !s.ex.def._abierta) {
      this.iniciarRomper(jug, s);
      return;
    }
    // 3) salida normal: reofrecer
    if (s) { this.ofrecer(jug, s); return; }
    if (prop) { this.esconder(jug, true, prop); return; }
  }

  esconder(jug, si, prop) {
    if (si) {
      jug.escondido = { x: prop.x, y: prop.y };
      this.enviar(jug.ws, { t: 'aviso', txt: 'Te metes dentro. Nada debería verte… si nadie te vio entrar.' });
    } else {
      jug.escondido = null;
    }
    this.difundir({ t: 'esconde', id: jug.id, si: !!si });
  }

  // ---------- romper pared/suelo: canal de 1 s + dado ----------
  iniciarRomper(jug, { i, ex }) {
    const herramienta = jug.manos.includes('tuberia');
    jug.canal = { tipo: 'romper', i, hasta: Date.now() + 1000, herramienta };
    this.hacerRuido(jug.x, jug.y, 10);
    this.difundir({ t: 'canal', id: jug.id, ms: 1000 });
  }

  cancelarCanal(jug, motivo) {
    jug.canal = null;
    this.enviar(jug.ws, { t: 'canalFin', ok: false });
    if (motivo) this.enviar(jug.ws, { t: 'aviso', txt: motivo });
  }

  resolverCanal(jug) {
    const c = jug.canal;
    jug.canal = null;
    const ex = this.map.exits[c.i];
    if (!ex || ex.def._abierta) return;
    const d = this.rng.int(1, 20);
    const esSuelo = ex.def._mec === 'romper_suelo';
    const umbral = c.herramienta ? 7 : (esSuelo ? 11 : 12);
    const exito = d >= umbral;
    this.difundir({ t: 'dado', id: jug.id, valor: d, exito });
    this.enviar(jug.ws, { t: 'canalFin', ok: true });
    if (exito) {
      ex.def._abierta = true;
      this.difundir({ t: 'abierto', i: c.i });
      this.hacerRuido(ex.x, ex.y, 12);
    } else if (!c.herramienta) {
      // romper a puñetazos/pisotones duele
      jug.salud = Math.max(0, jug.salud - 2);
      this.enviar(jug.ws, { t: 'salud', valor: jug.salud });
      if (jug.salud <= 0) this.morir(jug, 'tus propios golpes');
    }
  }

  // ---------- cruzar salidas ----------
  cruzar(jug, si) {
    if (!si) { jug.ofertaEn = null; return; }
    const s = this.salidaEn(jug.x, jug.y);
    if (!s || jug.muerto) return;
    const def = s.ex.def;
    if ((def._mec === 'romper' || def._mec === 'romper_suelo') && !def._abierta) return;
    if (!DATA.levels[def.destino]) {
      this.enviar(jug.ws, { t: 'aviso', txt: 'Ese camino no lleva a ninguna parte (nivel fuera del piloto).' });
      return;
    }
    // cruzar por donde nadie debería te sintoniza con el lugar
    if (def.tipo === 'arriesgada' || def.tipo === 'void') this.tune(jug, 5);
    if (this.alCruzar) this.alCruzar(jug, this, def);
  }

  // ---------- manos: tubería (golpe a la casilla encarada) y linterna ----------
  usar(jug, mano) {
    if (jug.muerto || jug.escondido) return;
    const id = jug.manos[mano];
    if (id === 'linterna') { this.luz(jug, !jug.luz); return; }
    if (id !== 'tuberia') return;
    const ahora = Date.now();
    if (ahora - (jug.ultGolpe || 0) < 400) return;
    jug.ultGolpe = ahora;
    const VEC = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    const [fx, fy] = VEC[jug.rot ?? 2];
    const tx = jug.x + fx, ty = jug.y + fy;
    this.difundir({ t: 'golpe', id: jug.id, x: tx, y: ty });
    this.hacerRuido(jug.x, jug.y, 8);
    const e = this.entidades.find((e2) => e2.viva && e2.x === tx && e2.y === ty);
    if (!e) return;
    e.vida -= 12;
    e.revelada = true;
    if (e.vida <= 0) {
      e.viva = false;
      this.difundir({ t: 'entMuere', uid: e.uid });
      this.tune(jug, 8); // matar es el mayor de los horrores presenciables
    } else {
      this.difundir({ t: 'entHit', uid: e.uid });
    }
  }

  luz(jug, si) {
    jug.luz = !!si;
    this.difundir({ t: 'luzDe', id: jug.id, si: jug.luz });
  }

  hacerRuido(x, y, radio) {
    this.ruido = { x, y, radio, hasta: Date.now() + 3200 };
  }

  // ---------- muerte: como el roguelike, despiertas otra vez en Level 0 ----------
  morir(jug, causa) {
    jug.muerto = true;
    jug.escondido = null;
    jug.canal = null;
    db.sumarMuerte(jug.token);
    this.difundir({ t: 'muere', id: jug.id, causa });
    setTimeout(() => {
      if (!this.jugadores.has(jug.id)) return;
      jug.salud = 100;
      jug.muerto = false;
      jug.inv = []; jug.manos = [null, null];
      if (this.alMorir) this.alMorir(jug, this, causa);
    }, 2500);
  }

  // ---------- tick de simulación (lo llama server.js a 10 Hz) ----------
  tick(ahora) {
    if (!this.jugadores.size) return;
    for (const jug of this.jugadores.values())
      if (jug.canal && ahora >= jug.canal.hasta) this.resolverCanal(jug);
    Entidades.tick(this, ahora);
  }

  chat(jug, txt) {
    const ahora = Date.now();
    if (ahora < (jug.muteadoHasta || 0)) {
      this.enviar(jug.ws, { t: 'aviso', txt: 'Estás silenciado. Las paredes no te escuchan.' });
      return;
    }
    if (ahora - jug.ultChat < P.COOLDOWN_CHAT) {
      this.enviar(jug.ws, { t: 'aviso', txt: 'Más despacio: un mensaje cada segundo y medio.' });
      return;
    }
    jug.ultChat = ahora;
    // chat de PROXIMIDAD: solo lo oye quien está a ≤14 casillas del que habla
    // (ni siquiera viaja por la red a los demás — nada de espiar el tráfico)
    const raw = JSON.stringify({ t: 'chat', id: jug.id, txt });
    for (const j of this.jugadores.values()) {
      if (j.ws.readyState !== 1) continue;
      if (j.id !== jug.id && Math.hypot(j.x - jug.x, j.y - jug.y) > P.RADIO_CHAT) continue;
      j.ws.send(raw);
    }
  }

  girar(jug, rot) {
    if (jug.rot === rot) return;
    jug.rot = rot;
    this.difundir({ t: 'gira', id: jug.id, rot }, jug.id);
  }

  enviar(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  difundir(msg, exceptoId) {
    const raw = JSON.stringify(msg);
    for (const j of this.jugadores.values())
      if (j.id !== exceptoId && j.ws.readyState === 1) j.ws.send(raw);
  }
}

// ---------- registro de salas ----------
const salas = new Map();

function asignar(nivelId) {
  let inst = 1;
  for (;;) {
    const clave = `${nivelId}::${inst}`;
    let sala = salas.get(clave);
    if (!sala) {
      sala = new Sala(nivelId, inst);
      salas.set(clave, sala);
      console.log(`[sala] abierta ${clave} (${sala.map.grid.w}×${sala.map.grid.h}, ${sala.entidades.length} entidades)`);
    }
    if (!sala.llena) return sala;
    inst++;
  }
}

// métricas del bucle de simulación (visibles en /estado)
const metricas = { ultMs: 0, maxMs: 0, medias: [] };

function tickTodas(ahora) {
  const t0 = process.hrtime.bigint();
  for (const s of salas.values()) {
    // una sala rota no puede tumbar el resto del mundo
    try { s.tick(ahora); } catch (e) { console.error(`[sala ${s.clave}] tick:`, e.message); }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  metricas.ultMs = ms;
  if (ms > metricas.maxMs) metricas.maxMs = ms;
  metricas.medias.push(ms);
  if (metricas.medias.length > 300) metricas.medias.shift(); // últimos 30 s
}

function estado() {
  const media = metricas.medias.length
    ? metricas.medias.reduce((a, b) => a + b, 0) / metricas.medias.length : 0;
  return {
    salas: [...salas.values()].map((s) => ({
      clave: s.clave, jugadores: s.jugadores.size,
      entidades: s.entidades.filter((e) => e.viva).length,
    })),
    total: [...salas.values()].reduce((n, s) => n + s.jugadores.size, 0),
    tick: { ultimoMs: +metricas.ultMs.toFixed(2), medioMs: +media.toFixed(2), maxMs: +metricas.maxMs.toFixed(2) },
    memoriaMB: Math.round(process.memoryUsage().rss / 1048576),
  };
}

function todas() { return [...salas.values()]; }

module.exports = { Sala, asignar, tickTodas, estado, todas };
