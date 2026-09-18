# Semantic Engine Roadmap

## Objetivo

Evolucionar `smart-context-mcp` desde un índice estructural de archivos y símbolos hacia inteligencia semántica fiable para agentes, sin romper las herramientas actuales ni introducir dependencias pesadas.

Principios:

- Comportamiento actual compatible por defecto.
- Deterministic first: TypeScript LanguageService antes que heurísticas o modelos externos.
- Fallback funcional cuando no exista información semántica.
- Respuestas compactas: ubicaciones, símbolos y relaciones; no cuerpos completos.
- Cada fase debe tener tests y una métrica de salida antes de iniciar la siguiente.

## Estado

- [x] Fase 0: estabilización y benchmark base
- [x] Fase 1: proveedor semántico TypeScript
- [x] Fase 2: herramienta `smart_code`
- [x] Fase 3: integración semántica en `smart_context`
- [x] Fase 4: análisis de impacto
- [x] Fase 5: refactoring semántico (`rename`; `replace_body`/`insert_*` diferidos)
- [x] Fase 6: almacenamiento inteligente de outputs
- [ ] Fase 7: consolidación de la API MCP (bloqueada a propósito: requiere métricas de adopción)

## Punto De Reanudacion

**Ultima actualizacion:** 2026-09-18

**Estado global:** Fases 0–6 completadas (sin commit todavia). Superficie MCP: **22 tools** (`smart_code` en Fase 2, `smart_output` en Fase 6). Siguiente: suite completa, release bump (docs 20→22 tools + CHANGELOG) y commit. Fase 7 queda fuera hasta tener metricas de adopcion.

### Ya implementado

- Contrato semantico + proveedor TypeScript + fallback.
- Resolucion por nombre y diagnostics compactos.
- Tool MCP `smart_code` (definition/references/implementations/diagnostics/**impact**).
- `smart_context` opt-in `include: ['semantic']` + `whyIncluded`.
- **Fase 4:** `src/semantic/impact.js` + `smart_code({ action: 'impact' })`.
  - Directo: semantic (definitions/references/implementations).
  - Transitivo: import-graph (`basis: heuristic-expansion`, nota explicita).
  - Tests: union semantic + graph.
  - Coverage flags + `risk` con `basis: 'heuristic'` (nunca se presenta como certeza semantica).
- Parametro `maxHops` (default 2) para el grafo transitivo.
- **Fase 5:** `src/semantic/rename.js` + `smart_code({ action: 'rename' })`.
  - `dryRun: true` por defecto: devuelve plan (`filesAffected`, `totalEdits`, hunks `before`/`after` por linea) y no escribe nada.
  - Rename scope-aware via `findRenameLocations`; nuevo `renameLocations` + `touchFiles` en el proveedor TS (y no-ops en fallback).
  - Conflictos `severity: 'error'` bloquean siempre la escritura: `invalid-name` (identificador invalido o palabra reservada), `same-name`, `unresolved-target`, `no-locations`, `unsupported-provider`, `path-escape`, `missing-file`, `too-many-files`.
  - `name-collision` es `severity: 'warning'` con `basis: 'heuristic'`: solo bloquea con `strict: true` (la deteccion no verifica solape de scope).
  - Escrituras via `resolveSafePath` y edits aplicados por offset descendente; `diagnosticsAfter` reporta errores TS restantes en los archivos tocados.
  - El plan nunca expone cuerpos de archivo, solo hunks recortados a 200 caracteres.
- **Fase 6:** `src/outputs/{store,summarize}.js` + tabla `outputs` (schema SQLite **9**) + tool `smart_output`.
  - Acciones: `save`, `search`, `excerpt`, `summary`, `list`, `stats`, `prune`.
  - Retencion, limite de tamano, dedupe, scrubbing y degradacion documentados en la seccion de Fase 6.
  - Captura automatica opt-in (`DEVCTX_OUTPUT_STORE=true`); `smart_shell` expone `outputRef` y `smart_test` lo propaga.
  - `smart_output` registrado en el runner de playbooks; `debug-flake` recupera los ultimos fallos de test.
- Tests dirigidos: **36 pass** (19 semantic + 17 outputs).

### Verificacion realizada

```text
node --test tests/semantic-provider.test.js          → 19 passed, 0 failed
node --test tests/smart-output.test.js               → 17 passed, 0 failed
node --test tests/sqlite-storage.test.js \
  tests/smart-shell.test.js tests/smart-test.test.js \
  tests/smart-playbook.test.js tests/smart-doctor.test.js
                                                     → 40 passed, 1 skipped, 0 failed
```

### Pendiente inmediato

1. Suite completa `npm test` con timeout largo.
2. Release bump: version + READMEs 20→**22** tools + CHANGELOG, luego commit.
3. No activar semantic por defecto en `smart_context` hasta benchmark precision@5.
4. No activar `DEVCTX_OUTPUT_STORE` por defecto hasta medir tamano real de `state.sqlite` en uso continuado.
5. `replace_body` / `insert_before` / `insert_after` quedan diferidos: `rename` cubre el caso de alto valor y el resto solapa con `smart_edit`.

### Archivos de esta linea de trabajo

- `docs/semantic-engine-roadmap.md`
- `tools/devctx/src/semantic/*` (incluye `impact.js`, `context-expand.js`)
- `tools/devctx/src/tools/smart-code.js`
- `tools/devctx/src/tools/smart-context.js`
- `tools/devctx/src/utils/context-scoring.js`
- `tools/devctx/src/server.js`
- `tools/devctx/src/playbooks/runner.js`
- `tools/devctx/tests/semantic-provider.test.js`
- `tools/devctx/tests/smart-context-semantic.test.js`
- `.agent/handoff.md`

### Como continuar

Leer este apartado. Si release: bumpear version y sync docs de tool count. Si Fase 5: empezar por `rename` dry-run usando el proveedor TS; no tocar output store.

Progreso actual:

- Fases 0–4 listas.
- Suite dirigida semantica: 19/19 pass.
- Trabajo sin commit (pendiente decision del usuario).

## Decisiones iniciales

### Proveedor semántico

La primera implementación usará `typescript.LanguageService` para JavaScript y TypeScript. La dependencia `typescript` ya forma parte del paquete y permite resolver definiciones, referencias e implementaciones sin gestionar procesos LSP externos.

Un gestor LSP genérico queda aplazado hasta que exista una segunda familia de lenguajes que justifique su complejidad operativa.

### Persistencia

Las relaciones semánticas se calcularán bajo demanda al principio. Solo se persistirán o cachearán las operaciones cuyo coste y frecuencia estén demostrados por métricas.

### API pública

Se añadirá una única herramienta nueva, `smart_code`, en lugar de exponer una herramienta MCP por operación. Las funciones internas podrán permanecer separadas.

### Integración contextual

La semántica será inicialmente opt-in en `smart_context`. El comportamiento existente seguirá siendo el camino por defecto hasta comprobar que la expansión semántica mejora precisión y coste.

## Fase 0: estabilización y benchmark base

### Trabajo

- Revisar migraciones y compatibilidad con bases SQLite antiguas o incompletas.
- Resolver el caso observado en el que falta la tabla `noise_hints`.
- Definir fixtures pequeños JS/TS para referencias, definiciones e implementaciones.
- Medir el comportamiento actual de `smart_context`, `smart_search` y `smart_test`.

### Criterios de salida

- Las bases SQLite antiguas fallan de forma diagnosticable o se migran con seguridad.
- Existe un benchmark reproducible con tokens, latencia, llamadas, archivos incluidos y precisión de contexto.
- El benchmark queda guardado como baseline para comparar las siguientes fases.

## Fase 1: proveedor semántico TypeScript

### Estructura prevista

```text
tools/devctx/src/semantic/
  semantic-provider.js
  types.js
  typescript-provider.js
  fallback-provider.js
```

### Operaciones

- `definition`
- `references`
- `implementations`
- `hover` como capacidad opcional

### Tests mínimos

- Referencias dentro del mismo archivo.
- Referencias entre archivos.
- Imports, exports y aliases.
- Interfaces e implementaciones.
- JavaScript y TypeScript.
- Proyecto sin `tsconfig` válido.
- Archivo o símbolo inexistente.
- Errores, timeouts y fallback.

### Criterios de salida

- El proveedor devuelve ubicaciones normalizadas relativas al proyecto.
- La salida tiene un contrato estable y límites explícitos.
- Un fallo semántico no rompe las herramientas existentes.

## Fase 2: herramienta `smart_code`

### API inicial

```js
smart_code({
  action: 'references',
  filePath: 'src/auth/service.ts',
  symbol: 'validateToken',
  includeTests: true,
  maxResults: 20,
})
```

Acciones iniciales:

- `definition`
- `references`
- `implementations`

### Reglas de respuesta

- Incluir símbolo consultado, definición, resultados, total y cantidad devuelta.
- Incluir archivo, línea, columna cuando exista, símbolo contenedor y relación.
- Indicar proveedor usado y nivel de confianza.
- No incluir contenido de archivos salvo que se solicite explícitamente en una fase posterior.

### Criterios de salida

- Tests unitarios y de integración con fixtures.
- Compatibilidad con repositorios sin soporte semántico.
- Métricas de latencia, resultados truncados y uso del fallback.

## Fase 3: integración en `smart_context`

Añadir una opción explícita, por ejemplo:

```js
smart_context({
  task: 'fix admin permissions',
  include: ['content', 'graph', 'hints', 'symbolDetail', 'semantic'],
})
```

La expansión semántica debe:

- Detectar callers, implementaciones y tests relacionados.
- Mejorar el ranking de candidatos.
- Explicar por qué se incluyó cada archivo.
- Respetar el presupuesto de tokens.
- Mantener el grafo de imports como fallback.

### Criterios de salida

- El modo actual produce los mismos resultados salvo mejoras explícitamente activadas.
- El modo semántico demuestra mejora en precisión@5 o reducción de llamadas.
- No aumenta de forma inaceptable la latencia ni el consumo de tokens.

## Fase 4: análisis de impacto

Añadir `smart_code(action='impact')` reutilizando referencias, implementaciones, tests afectados, `smart_test(affected)` y el grafo existente.

La respuesta debe separar:

- Impacto directo.
- Impacto transitivo.
- Tests relacionados.
- Cobertura y confianza.
- Riesgo estimado con una explicación verificable.

No se debe presentar una estimación heurística como certeza semántica.

## Fase 5: refactoring semántico

Implementado: `rename` mediante el proveedor semántico, con `dryRun: true` como valor por defecto, validación de rutas contra el project root, detección de conflictos (errores bloqueantes y warnings heurísticos), diff previsto por hunks y `diagnosticsAfter` tras una escritura real.

Diferido tras evaluación:

- `replace_body`
- `insert_before`
- `insert_after`

`rename` es la operación donde el análisis semántico aporta valor que la sustitución textual no puede dar (scope, call sites, re-exports). Las otras tres son esencialmente edición posicional y solapan con `smart_edit`, así que no se implementan todavía. No se sustituye `smart_edit`; ambas capacidades tienen casos de uso distintos.

## Fase 6: almacenamiento inteligente de outputs

Implementado: output/artifact store persistente en la tabla `outputs` de `state.sqlite`, con los kinds `shell`, `test`, `build`, `lint` y `diff`.

Herramienta `smart_output` con acciones `save`, `search`, `excerpt`, `summary`, `list`, `stats` y `prune`. Las cuatro primeras son el núcleo pedido; `save` es necesaria para que exista algo que recuperar y `stats`/`prune` son la superficie de control de la retención.

Las cinco condiciones que el roadmap exigía antes de activarlo quedan resueltas así:

- **Retención:** `DEVCTX_OUTPUT_RETENTION_DAYS` (14 por defecto) y `DEVCTX_OUTPUT_MAX_PER_KIND` (50 por defecto). Se aplica en cada `save` (con throttle de 60 s), en `action: 'prune'` y en `runStorageMaintenance`.
- **Límite de tamaño:** `DEVCTX_OUTPUT_MAX_BYTES` (256 KB por defecto). Por encima se truncan las líneas centrales conservando cabeza y cola, porque el fallo casi siempre está al final; el marcador indica cuántas líneas se omitieron.
- **Limpieza:** dedupe por `(kind, command, content_hash)` que incrementa `repeat_count` en lugar de duplicar filas, más el prune por antigüedad y por tope de filas por kind.
- **Privacidad:** el contenido pasa por `scrubContent` (claves de API, JWT, cadenas de conexión, emails, rutas de home) antes de persistirse. `search` nunca devuelve el cuerpo completo, solo metadatos y las líneas que coinciden.
- **SQLite bloqueado, ausente o corrupto:** toda operación pasa por `safeStoreCall`, así que devuelve `degraded: true` con el motivo y nunca lanza. En Node <22 el store simplemente no está disponible y el resto de devctx sigue funcionando.

La captura automática desde `smart_shell` y `smart_test` es opt-in vía `DEVCTX_OUTPUT_STORE=true`; `save` y `search` explícitos funcionan siempre. Cuando la captura está activa, `smart_shell` devuelve `outputRef` y `smart_test` lo propaga, de modo que el agente puede recuperar el output completo sin repetir el comando. El playbook `debug-flake` consulta los últimos fallos de test persistidos.

Nota: el store guarda el output crudo (ya saneado), no el comprimido que devuelve `smart_shell`. Esa es justamente su razón de ser: la respuesta al agente sigue siendo compacta y el detalle queda recuperable a demanda.

Métricas objetivo:

- reruns evitados
- tokens evitados mediante recuperación
- tiempo hasta recuperar un stack trace

## Fase 7: consolidación de la API MCP

Solo después de validar el uso real se evaluará una API agrupada:

```text
smart_context
smart_code
smart_run
smart_memory
smart_admin
```

La migración debe ser gradual y preservar las herramientas actuales durante un periodo de compatibilidad. No se hará una reducción de superficie MCP antes de disponer de métricas de adopción y clientes verificados.

## Fuera de alcance inicial

- Vector database.
- Embeddings pesados.
- LLM summarizer como dependencia básica.
- Context7 o crawler de documentación externa.
- Type hierarchy y call hierarchy genéricos.
- Grafo semántico persistente completo.

Estas capacidades podrán evaluarse después de validar las referencias e implementaciones TypeScript.

## Benchmark de validación

Preparar al menos 20 tareas reales o representativas, incluyendo bugs, refactors y cambios transversales. Comparar baseline contra cada fase en:

- tokens consumidos
- llamadas de herramientas
- lecturas completas
- búsquedas repetidas
- archivos relevantes incluidos
- precisión@5 del contexto
- latencia
- tarea completada correctamente

Una fase no se considera terminada solo porque sus tests unitarios pasen: debe conservar o mejorar estos indicadores.

## Siguiente incremento

Proxima sesion: release bump (tool count 21 + CHANGELOG) **o** Fase 5 `rename` con `dryRun: true` por defecto. No activar semantic por defecto en `smart_context` hasta benchmark precision@5.
