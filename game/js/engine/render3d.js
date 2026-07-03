// Render 3D (Three.js local): mundo con volumen real y cámara inclinada estilo
// Octopath. Reutiliza TODAS las texturas procedurales existentes (tiles.js,
// sprites.js, render.js→exitToCanvas) como CanvasTexture. La lógica del juego
// (FOV, turnos, entidades) no cambia: esto es solo presentación.
(function () {
  if (!window.THREE) { window.Render3D = null; return; }

  // ---- constantes de cámara y escena (afinables) ----
  const CAM = { fov: 44, dy: 5.8, dz: 4.2, lookY: 0.4, lookAhead: 1.1, suavidad: 0.06, bob: 0.007 };
  let camRot = 0;          // rotación de cámara en pasos de 90° (0-3), tecla Q
  let camYaw = 0;          // yaw animado (radianes)
  const WALL_H = 1.2;      // altura de los muros en unidades-tile (referencia Octopath)
  const SPRITE_H = 1.05;   // alto del billboard de actores

  let renderer, scene, camera, amb, plight;
  let glCanvas, overlay, octx, W, H;
  let levelKey = null;
  let levelGroup = null;
  let entitySprites = new Map(); // uid -> THREE.Sprite
  let itemSprites = new Map();   // index -> sprite
  let playerSprite = null;
  let texCache = new Map();      // clave -> THREE.Texture
  let grain = null;
  let camBobT = 0;

  function tex(canvas, key) {
    if (key && texCache.has(key)) return texCache.get(key);
    const t = new THREE.CanvasTexture(canvas);
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.encoding = THREE.sRGBEncoding;
    if (key) texCache.set(key, t);
    return t;
  }

  function init(gl, ov) {
    glCanvas = gl; overlay = ov;
    W = gl.width; H = gl.height;
    octx = ov.getContext('2d');
    renderer = new THREE.WebGLRenderer({ canvas: gl, antialias: false });
    renderer.setSize(W, H, false);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.BasicShadowMap;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(CAM.fov, W / H, 0.1, 60);
    amb = new THREE.AmbientLight(0xffffff, 0.4);
    plight = new THREE.PointLight(0xffffff, 1.7, 12, 1.8);
    plight.castShadow = true;
    plight.shadow.mapSize.set(512, 512);
    plight.shadow.bias = -0.01;
    scene.add(amb, plight);

    // grano para el overlay
    grain = document.createElement('canvas');
    grain.width = 256; grain.height = 256;
    const gctx = grain.getContext('2d');
    const img = gctx.createImageData(256, 256);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 22;
    }
    gctx.putImageData(img, 0, 0);
  }

  // ---------- construcción de la escena del nivel ----------
  let lastLevelId = null;
  let solidosCamara = [];
  const rayo = new THREE.Raycaster();
  function disposeLevel(keepTex) {
    if (!levelGroup) return;
    levelGroup.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) { if (!keepTex && m.map) m.map.dispose(); m.dispose(); }
      }
    });
    scene.remove(levelGroup);
    levelGroup = null;
    entitySprites.clear();
    itemSprites.clear();
    playerSprite = null;
    if (!keepTex) texCache.clear(); // rebuilds del mismo nivel reutilizan texturas (sin hitch)
  }

  function quad(pos, uv, idx, corners, uvRect) {
    const base = pos.length / 3;
    for (const c of corners) pos.push(c[0], c[1], c[2]);
    const [u0, v0, u1, v1] = uvRect;
    uv.push(u0, v1, u1, v1, u1, v0, u0, v0);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  function buildLevel(world) {
    disposeLevel(lastLevelId === world.level.id);
    lastLevelId = world.level.id;
    const g = world.map.grid;
    const T = MapGen.T;
    const tiles = world.tiles;
    const pal = world.level.paleta;
    levelGroup = new THREE.Group();

    // --- atlas de suelo: [suelo0, suelo1, suelo2, agua, decor] ---
    const atlas = document.createElement('canvas');
    atlas.width = 48 * 5; atlas.height = 48;
    const actx = atlas.getContext('2d');
    const slots = [tiles.suelo[0], tiles.suelo[1], tiles.suelo[2], tiles.agua, tiles.decor];
    slots.forEach((c, i) => actx.drawImage(c, i * 48, 0));
    const floorPos = [], floorUv = [], floorIdx = [];
    const U = 1 / 5;
    for (let y = 0; y < g.h; y++)
      for (let x = 0; x < g.w; x++) {
        const v = g.t[y * g.w + x];
        if (v === T.VACIO || v === T.PARED) continue;
        const slot = v === T.AGUA ? 3 : v === T.DECOR ? 4 : (x * 7 + y * 13) % 3;
        quad(floorPos, floorUv, floorIdx,
          [[x, 0, y + 1], [x + 1, 0, y + 1], [x + 1, 0, y], [x, 0, y]],
          [slot * U, 0, (slot + 1) * U, 1]);
      }
    const floorGeom = new THREE.BufferGeometry();
    floorGeom.setAttribute('position', new THREE.Float32BufferAttribute(floorPos, 3));
    floorGeom.setAttribute('uv', new THREE.Float32BufferAttribute(floorUv, 2));
    floorGeom.setIndex(floorIdx);
    floorGeom.computeVertexNormals();
    const floorMesh = new THREE.Mesh(floorGeom,
      new THREE.MeshLambertMaterial({ map: tex(atlas, 'atlas-suelo') }));
    floorMesh.receiveShadow = true;
    levelGroup.add(floorMesh);

    // --- muros ---
    const esWall = (x, y) => MapGen.at(g, x, y) === T.PARED;
    if (tiles.wallStyle === 'tabique') {
      const sidePos = [], sideUv = [], sideIdx = [];
      const topPos = [], topUv = [], topIdx = [];
      for (let y = 0; y < g.h; y++)
        for (let x = 0; x < g.w; x++) {
          if (!esWall(x, y)) continue;
          const h = WALL_H;
          // caras laterales solo hacia espacios abiertos (culling interior)
          if (!esWall(x, y + 1)) quad(sidePos, sideUv, sideIdx,
            [[x, 0, y + 1], [x + 1, 0, y + 1], [x + 1, h, y + 1], [x, h, y + 1]], [0, 0, 1, 1]);
          if (!esWall(x, y - 1)) quad(sidePos, sideUv, sideIdx,
            [[x + 1, 0, y], [x, 0, y], [x, h, y], [x + 1, h, y]], [0, 0, 1, 1]);
          if (!esWall(x - 1, y)) quad(sidePos, sideUv, sideIdx,
            [[x, 0, y], [x, 0, y + 1], [x, h, y + 1], [x, h, y]], [0, 0, 1, 1]);
          if (!esWall(x + 1, y)) quad(sidePos, sideUv, sideIdx,
            [[x + 1, 0, y + 1], [x + 1, 0, y], [x + 1, h, y], [x + 1, h, y + 1]], [0, 0, 1, 1]);
          quad(topPos, topUv, topIdx,
            [[x, h, y + 1], [x + 1, h, y + 1], [x + 1, h, y], [x, h, y]], [0, 0, 1, 1]);
        }
      const mkMesh = (pos, uv, idx, canvas, key, sombra) => {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        geo.setIndex(idx);
        geo.computeVertexNormals();
        const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex(canvas, key) }));
        m.castShadow = sombra;
        m.receiveShadow = true;
        return m;
      };
      // cara sin la franja de techo (solo el muro): recorte del caraFull
      const caraSolo = document.createElement('canvas');
      caraSolo.width = 48; caraSolo.height = 48;
      caraSolo.getContext('2d').drawImage(tiles.caraFull[1], 0, Tiles.RF, 48, Tiles.FH, 0, 0, 48, 48);
      const lados = mkMesh(sidePos, sideUv, sideIdx, caraSolo, 'muro-lado', true);
      const techos = mkMesh(topPos, topUv, topIdx, tiles.techo, 'muro-techo', false);
      levelGroup.add(lados, techos);
      solidosCamara = [lados, techos]; // para la colisión de la cámara
    } else {
      // bosque/exterior: árboles y rocas como billboards verticales
      const canvas = tiles.wallStyle === 'arbol' ? tiles.arbol : tiles.roca;
      const mat = new THREE.SpriteMaterial({ map: tex(canvas, 'muro-organico'), transparent: true });
      for (let y = 0; y < g.h; y++)
        for (let x = 0; x < g.w; x++) {
          if (!esWall(x, y)) continue;
          const s = new THREE.Sprite(mat);
          const escala = tiles.wallStyle === 'arbol' ? 1.5 : 1.25;
          s.scale.set(escala, escala * (canvas.height / canvas.width), 1);
          s.position.set(x + 0.5, escala * 0.48, y + 0.5);
          levelGroup.add(s);
        }
    }

    // --- salidas ---
    const PEGADAS = new Set(['puerta', 'ventana']);
    const RITUAL_PARED = new Set(['reloj', 'vending', 'boton']);
    world.map.exits.forEach((ex, exI) => {
      const paredNorte = esWall(ex.x, ex.y - 1) && tiles.wallStyle === 'tabique';
      const c = Render.exitToCanvas(ex.def);
      const estilo = ex.def.ritual ? 'ritual' : Render.exitStyle(ex.def);
      const t2 = tex(c, 'exit-' + exI);
      if (estilo === 'trampilla' || estilo === 'escalera') {
        // plano tumbado sobre el suelo
        const m = new THREE.Mesh(
          new THREE.PlaneGeometry(0.95, 0.95),
          new THREE.MeshBasicMaterial({ map: t2, transparent: true })
        );
        m.rotation.x = -Math.PI / 2;
        m.position.set(ex.x + 0.5, 0.02, ex.y + 0.5);
        levelGroup.add(m);
      } else if (paredNorte &&
        (PEGADAS.has(estilo) || (ex.def.ritual && RITUAL_PARED.has(ex.def.ritual)))) {
        // FÍSICAMENTE en la cara sur del muro norte: plano vertical fijo
        const m = new THREE.Mesh(
          new THREE.PlaneGeometry(1, 1.4),
          new THREE.MeshBasicMaterial({ map: t2, transparent: true })
        );
        m.position.set(ex.x + 0.5, 0.7, ex.y + 0.045);
        levelGroup.add(m);
      } else if (ex.def.ritual === 'nave') {
        // pedestal 3D con la nave encima
        const ped = new THREE.Mesh(
          new THREE.BoxGeometry(0.5, 0.6, 0.5),
          new THREE.MeshLambertMaterial({ color: 0x6a6a72 })
        );
        ped.position.set(ex.x + 0.5, 0.3, ex.y + 0.5);
        ped.castShadow = true;
        levelGroup.add(ped);
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t2, transparent: true }));
        s.scale.set(0.8, 1.2, 1);
        s.position.set(ex.x + 0.5, 0.95, ex.y + 0.5);
        levelGroup.add(s);
      } else {
        // puerta/objeto exento: caja fina con profundidad real
        const frente = new THREE.MeshBasicMaterial({ map: t2, transparent: true });
        const lado = new THREE.MeshLambertMaterial({ color: 0x2a2620 });
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(0.95, 1.42, 0.1),
          [lado, lado, lado, lado, frente, frente]
        );
        m.position.set(ex.x + 0.5, 0.71, ex.y + 0.5);
        m.castShadow = true;
        levelGroup.add(m);
      }
    });

    // --- props: muebles como GEOMETRÍA 3D empotrada, no sprays 2D ---
    const PROPS_PARED = new Set(['taquilla', 'archivador', 'nevera', 'reloj', 'camilla']);
    const CAJAS = new Set(['cofre', 'caja', 'bidon']);
    const LADO_COLOR = {
      taquilla: 0x46525c, archivador: 0x625c4e, nevera: 0xa8b0ac, camilla: 0x7e8882,
      reloj: 0x4e3d2b, cofre: 0x5e4830, caja: 0x6e5434, bidon: 0x324a3e,
    };
    for (const pr of world.map.props || []) {
      const c = Render.propToCanvas(pr.id);
      const frontTex = tex(c, 'prop-' + pr.id);
      const arrimado = PROPS_PARED.has(pr.id) && esWall(pr.x, pr.y - 1);
      if (arrimado) {
        // mueble EMPOTRADO contra el muro: caja con la cara frontal texturizada
        const frente = new THREE.MeshLambertMaterial({ map: frontTex, transparent: true });
        const lado = new THREE.MeshLambertMaterial({ color: LADO_COLOR[pr.id] ?? 0x555550 });
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(0.66, 1.12, 0.3),
          [lado, lado, lado, lado, frente, lado]
        );
        m.position.set(pr.x + 0.5, 0.56, pr.y + 0.17);
        m.castShadow = true;
        levelGroup.add(m);
        pr._mesh3d = m;
      } else if (CAJAS.has(pr.id)) {
        // cajas/cofres/bidones exentos: volumen pequeño
        const frente = new THREE.MeshLambertMaterial({ map: frontTex, transparent: true });
        const lado = new THREE.MeshLambertMaterial({ color: LADO_COLOR[pr.id] ?? 0x6e5434 });
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(0.55, 0.62, 0.45),
          [lado, lado, lado, lado, frente, lado]
        );
        m.position.set(pr.x + 0.5, 0.31, pr.y + 0.5);
        m.castShadow = true;
        levelGroup.add(m);
        pr._mesh3d = m;
      } else {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: frontTex, transparent: true }));
        s.scale.set(1, 1.5, 1);
        s.position.set(pr.x + 0.5, 0.62, pr.y + 0.5);
        levelGroup.add(s);
        pr._mesh3d = s;
      }
    }

    // --- objetos del suelo ---
    for (let i = 0; i < world.map.items.length; i++) {
      const it = world.map.items[i];
      const c = Render.itemToCanvas(it.id, world.data.objects);
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex(c, 'item-' + it.id), transparent: true }));
      s.scale.set(0.55, 0.6, 1);
      s.position.set(it.x + 0.5, 0.22, it.y + 0.5);
      levelGroup.add(s);
      itemSprites.set(i, s);
    }

    // --- jugador ---
    playerSprite = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true }));
    playerSprite.scale.set(1, SPRITE_H, 1);
    levelGroup.add(playerSprite);

    scene.add(levelGroup);

    // --- atmósfera del nivel ---
    const fondo = new THREE.Color(pal.fondo);
    scene.background = fondo;
    scene.fog = new THREE.FogExp2(fondo, 0.08 + world.level.oscuridad * 0.16);
    amb.intensity = Math.max(0.12, 0.55 - world.level.oscuridad * 0.4);
    plight.color = new THREE.Color(pal.luz);
    plight.distance = (world.visionActual() + 3) * 1.6;

    if (tiles.wallStyle !== 'tabique') solidosCamara = [];

    // posición inicial de cámara y punto de mira sin lerp (evita barridos raros)
    const p = world.player;
    camera.position.set(p.rx + 0.5, CAM.dy, p.ry + 0.5 + CAM.dz);
    frame._look = new THREE.Vector3(p.rx + 0.5, CAM.lookY, p.ry + 0.5);
  }

  function spriteTex(glyph, frame) {
    const key = 'ent-' + glyph + '-' + frame;
    if (texCache.has(key)) return texCache.get(key);
    const c = Sprites.get(glyph, frame);
    return c ? tex(c, key) : null;
  }

  function spriteTexFlip(glyph, frame, flip) {
    const key = 'ent-' + glyph + '-' + frame + (flip ? '-f' : '');
    if (texCache.has(key)) return texCache.get(key);
    const c = Sprites.get(glyph, frame, flip);
    return c ? tex(c, key) : null;
  }

  function entVisible(world, e) {
    const g = world.map.grid;
    const idx = e.y * g.w + e.x;
    const lit = world.light[idx];
    const esSmiler = e.def.glyph === 'smiler';
    return lit > 0.05 ||
      (e.reveladaHasta ?? -1) > world.turn || // revelada al chocar en la oscuridad
      (esSmiler && (world.explored[idx] || Math.hypot(e.x - world.player.x, e.y - world.player.y) < 9));
  }

  // fallback: entidades vectoriales (sin matriz de píxeles) → snapshot del dibujo 2D
  function entCanvas(e, frame) {
    const key = 'entvec-' + e.def.glyph + '-' + frame;
    if (texCache.has(key)) return texCache.get(key);
    const c = document.createElement('canvas');
    c.width = 48; c.height = 48;
    const o = c.getContext('2d');
    // usa el dibujante 2D existente sobre este canvas
    const fake = Object.create(e);
    fake.revelada = true;
    const octxOld = o; // Render._drawEntity dibuja en su ctx interno: usamos exportador
    // Render._drawEntity no acepta ctx externo: replicamos con sprites.get o círculo
    const spr = Sprites.get(e.def.glyph, frame);
    if (spr) o.drawImage(spr, 0, 0);
    else {
      o.fillStyle = e.def.color;
      o.beginPath(); o.arc(24, 24, 12, 0, 7); o.fill();
      o.strokeStyle = 'rgba(0,0,0,0.6)'; o.stroke();
    }
    return tex(c, key);
  }

  // ---------- frame ----------
  function frame(world, t) {
    if (!world.level || !world.map) return;
    const key = world.level.id + '::' + (world.entryCount?.[world.level.id] ?? 0) +
      '::' + (world.mapaVersion || 0); // remodelaciones no euclidianas → rebuild
    if (key !== levelKey) { levelKey = key; buildLevel(world); }

    const p = world.player;
    const px = p.rx + 0.5, pz = p.ry + 0.5;

    // jugador: orientación del sprite RELATIVA a la cámara rotada
    const dir = p.dir || 'down';
    let wx = 0, wy = 0;
    if (dir === 'down') wy = 1;
    else if (dir === 'up') wy = -1;
    else { wx = p.flip ? -1 : 1; }
    const th = camRot * Math.PI / 2;
    const svx = Math.round(Math.cos(th) * wx - Math.sin(th) * wy);
    const svy = Math.round(Math.sin(th) * wx + Math.cos(th) * wy);
    let sid, sflip = false;
    if (svy > 0) sid = 'player_down';
    else if (svy < 0) sid = 'player_up';
    else { sid = 'player_side'; sflip = svx < 0; }
    const pframe = world.moving ? Math.floor(t / 160) % 2 : 0;
    playerSprite.material.map = spriteTexFlip(sid, pframe, sflip);
    playerSprite.material.needsUpdate = true;
    playerSprite.position.set(px, SPRITE_H / 2 + 0.02, pz);

    // entidades (crear bajo demanda, ocultar si no visibles)
    for (const e of world.entities) {
      let s = entitySprites.get(e.uid);
      if (!e.viva) { if (s) s.visible = false; continue; }
      if (!s) {
        s = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true }));
        s.scale.set(1, SPRITE_H, 1);
        if (e.def.glyph === 'smiler') s.material.fog = false; // brilla en la oscuridad
        levelGroup.add(s);
        entitySprites.set(e.uid, s);
      }
      const visible = entVisible(world, e);
      s.visible = visible;
      if (!visible) continue;
      const frame2 = Math.floor(t / 280) % 2;
      const tx = spriteTex(e.def.glyph, frame2) || entCanvas(e, frame2);
      s.material.map = tx;
      s.material.needsUpdate = true;
      // embestida de ataque
      let ox = 0, oz = 0;
      if (e._atkT !== undefined) {
        const k = (t - e._atkT) / 240;
        if (k >= 0 && k <= 1) {
          const amp = Math.sin(Math.PI * k) * 0.38;
          ox = (world.player.x - e.x) * amp;
          oz = (world.player.y - e.y) * amp;
        }
      }
      // tinte de estado
      s.material.color.setHex(e.paralizada > 0 ? 0x77ccff : 0xffffff);
      if (e._hitT && t - e._hitT < 170) s.material.color.setHex(0xffaaaa);
      s.position.set(e.rx + 0.5 + ox, SPRITE_H / 2 + 0.02, e.ry + 0.5 + oz);
    }

    // objetos recogidos
    for (const [i, s] of itemSprites) s.visible = !world.map.items[i].taken;

    // luz del jugador con flicker fluorescente
    let flicker = 1;
    if (Math.random() < 0.015) flicker = 0.7;
    plight.intensity = plight.intensity * 0.85 + (1.7 * flicker) * 0.15;
    plight.position.set(px, 1.6, pz);
    if (p.luz) plight.distance = (world.visionActual() + 3) * 1.6;

    // cámara Octopath: baja, cercana, con inercia, bob sutil y rotación 90° (Q)
    if (world.moving) camBobT += 0.11;
    const bob = Math.sin(camBobT) * CAM.bob * (world.moving ? 1 : 0.15);
    const yawObjetivo = camRot * Math.PI / 2;
    // camino angular más corto
    let dyaw = yawObjetivo - camYaw;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    camYaw += dyaw * 0.1;
    const ox = Math.sin(camYaw) * CAM.dz;
    const oz = Math.cos(camYaw) * CAM.dz;
    let target = new THREE.Vector3(px + ox, CAM.dy + bob, pz + oz);
    // colisión de cámara: si un muro se interpone entre el jugador y la cámara,
    // la cámara se acerca hasta quedar delante (nunca tapa al jugador)
    if (solidosCamara.length) {
      // el rayo protege la visión de los PIES del jugador (lo primero que tapan los muros)
      const desde = new THREE.Vector3(px, 0.22, pz);
      const hacia = target.clone().sub(desde);
      const dist = hacia.length();
      rayo.set(desde, hacia.normalize());
      rayo.far = dist;
      const hits = rayo.intersectObjects(solidosCamara, false);
      if (hits.length && hits[0].distance < dist - 0.3) {
        if (hits[0].distance > 2.4) {
          // hay hueco: acercar la cámara hasta quedar delante del muro
          target = desde.clone().add(hacia.multiplyScalar(hits[0].distance - 0.35));
          target.y = Math.max(target.y, 2.4);
        } else {
          // el muro está encima del jugador: cámara casi cenital sobre él
          target = new THREE.Vector3(
            px + Math.sin(camYaw) * 1.2, 6.2, pz + Math.cos(camYaw) * 1.2
          );
        }
      }
    }
    camera.position.lerp(target, CAM.suavidad);
    // el punto de mira también con inercia: sin micro-tirones por paso
    frame._look = frame._look || new THREE.Vector3(px, CAM.lookY, pz);
    frame._look.lerp(
      new THREE.Vector3(px - Math.sin(camYaw) * CAM.lookAhead, CAM.lookY, pz - Math.cos(camYaw) * CAM.lookAhead),
      0.09
    );
    camera.lookAt(frame._look);

    renderer.render(scene, camera);
    drawOverlay(world, t);

    if (window.DEBUG3D_ON) {
      window.DEBUG3D = {
        cam: camera.position.toArray().map((v) => +v.toFixed(2)),
        look: frame._look ? frame._look.toArray().map((v) => +v.toFixed(2)) : null,
        player: [px.toFixed(1), pz.toFixed(1)],
        solidos: solidosCamara.length,
        yaw: +camYaw.toFixed(2),
      };
      document.title = JSON.stringify(window.DEBUG3D);
    }
  }

  function project(wx, wy) {
    const v = new THREE.Vector3(wx + 0.5, 0.8, wy + 0.5).project(camera);
    return [(v.x * 0.5 + 0.5) * W, (-v.y * 0.5 + 0.5) * H];
  }

  function drawOverlay(world, t) {
    octx.clearRect(0, 0, W, H);
    if (!window.NOFX) Effects.draw(octx, 0, 0, t, 48, project);

    // flash de daño
    const dt = t - world.ui.flashT;
    if (dt < 220) {
      octx.fillStyle = `rgba(160,20,20,${0.35 * (1 - dt / 220)})`;
      octx.fillRect(0, 0, W, H);
    }
    // cordura baja
    if (world.player.cordura < 30) {
      const sc = (30 - world.player.cordura) / 30;
      octx.fillStyle = `rgba(60,0,20,${0.14 * sc})`;
      octx.fillRect(0, 0, W, H);
    }
    if (!window.NOFX) {
      // viñeta + grano
      const vin = octx.createRadialGradient(W / 2, H / 2, H * 0.38, W / 2, H / 2, H * 0.8);
      vin.addColorStop(0, 'rgba(0,0,0,0)');
      vin.addColorStop(1, 'rgba(0,0,0,0.55)');
      octx.fillStyle = vin;
      octx.fillRect(0, 0, W, H);
      octx.globalAlpha = 0.45;
      octx.drawImage(grain, Math.random() * -80, Math.random() * -80, W + 160, H + 160);
      octx.globalAlpha = 1;
    }
  }

  window.Render3D = {
    init, frame, project, TILE: 48,
    rotar(dir = 1) { camRot = (camRot + dir + 4) % 4; },
    get rot() { return camRot; },
  };
})();
