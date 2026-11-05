# Distri Magik Agent

Backend en NestJS para consultar el catálogo de Distri Magik, preparar cotizaciones y responder consultas de clientes desde una API HTTP y un bot de Telegram. El asistente utiliza un modelo de Ollama y solo debe presentar como información comercial aquello que obtiene del catálogo de PostgreSQL.

## Contenido

- [Qué hace](#qué-hace)
- [Tecnologías](#tecnologías)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Requisitos y configuración](#requisitos-y-configuración)
- [Instalación y ejecución](#instalación-y-ejecución)
- [API HTTP](#api-http)
- [Bot de Telegram](#bot-de-telegram)
- [Base de datos y cotizaciones](#base-de-datos-y-cotizaciones)
- [Historial de Telegram](#historial-de-telegram)
- [Pruebas, formato y compilación](#pruebas-formato-y-compilación)
- [Despliegue y operación](#despliegue-y-operación)
- [Solución de problemas](#solución-de-problemas)

## Qué hace

La aplicación ofrece tres operaciones HTTP:

1. Buscar productos activos con existencias.
2. Cotizar un producto para una cantidad solicitada.
3. Enviar una consulta comercial al asistente, que combina el mensaje con resultados del catálogo y los consulta a Ollama.

También inicia un bot de Telegram cuando está configurado `TELEGRAM_BOT_TOKEN`. El bot puede buscar productos, guiar al cliente por una cotización y mantener un contexto conversacional por chat. Las cotizaciones son informativas: no confirman pedidos ni reservan inventario; requieren aprobación de un asesor.

## Tecnologías

- Node.js y TypeScript (módulos ES).
- NestJS 12 para la aplicación HTTP y la inyección de dependencias.
- PostgreSQL mediante `pg`.
- Ollama mediante su API HTTP local.
- Telegram mediante `node-telegram-bot-api` y long polling.
- pnpm para instalar dependencias.
- Vitest para pruebas y Oxlint para análisis estático.

## Estructura del proyecto

```text
.
├── data/
│   └── telegram-conversations.json   # Historial local creado en ejecución; no versionar
├── src/
│   ├── ai/
│   │   ├── ai.module.ts
│   │   └── ai.service.ts             # Búsqueda de contexto y comunicación con Ollama
│   ├── database/
│   │   ├── database.module.ts
│   │   ├── database.service.ts       # Pool PostgreSQL, catálogo y cotizaciones
│   │   └── database.service.spec.ts
│   ├── telegram/
│   │   ├── telegram.module.ts
│   │   └── telegram.service.ts       # Bot, comandos, flujos e historial
│   ├── app.controller.ts             # Rutas HTTP
│   ├── app.controller.spec.ts
│   ├── app.module.ts                 # Ensambla los módulos
│   ├── app.service.ts                # Servicio base de Nest
│   └── main.ts                       # Inicio del servidor
├── test/
│   └── app.e2e-spec.ts
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── vitest.config.ts
└── vitest.config.e2e.ts
```

### Módulos y flujo de dependencias

```text
AppModule
├── DatabaseModule  (global; ConfigModule y PostgreSQL)
├── AiModule        ────────────────┐
└── TelegramModule ──┬──────────────┘
                     ├── AiModule
                     └── DatabaseModule

AppController ──> AiService
              └─> DatabaseService

AiService ──────> DatabaseService ──> PostgreSQL
TelegramService ─> AiService
                └> DatabaseService
```

- **`DatabaseModule`** configura `ConfigModule` como global y exporta `DatabaseService`.
- **`DatabaseService`** administra el pool de conexiones, busca productos y calcula cotizaciones. Cierra el pool al detener Nest.
- **`AiModule` / `AiService`** construyen el contexto del catálogo y llaman a Ollama. El módulo exporta el servicio para la API y Telegram.
- **`TelegramModule` / `TelegramService`** habilitan long polling, procesan mensajes en serie por chat y guardan el historial local.
- **`AppController`** expone las rutas HTTP.
- **`main.ts`** crea la aplicación y escucha en `PORT` o, si no está definido, en el puerto `3000`.

## Requisitos y configuración

Se necesita:

- Node.js 20.19 o posterior.
- pnpm y acceso a los paquetes del lockfile.
- Una instancia PostgreSQL con el esquema y los datos del catálogo descritos más abajo.
- Ollama disponible en `http://localhost:11434` y el modelo `qwen3.5:4b` descargado. Ollama solo es necesario para la ruta `/chat` y las respuestas conversacionales de Telegram.
- Un token de bot de Telegram para habilitar la integración con Telegram.

Crea un archivo `.env` en la raíz del proyecto. No se distribuye una plantilla de entorno; usa este ejemplo y reemplaza los valores según el entorno:

```dotenv
# Servidor HTTP
PORT=3000

# PostgreSQL
DB_HOST=localhost
DB_PORT=5432
DB_NAME=systemdistrimagik
DB_USER=agente_ia_lectura
DB_PASSWORD=cambia_este_valor

# Telegram (opcional; sin este valor el servidor HTTP puede iniciar sin el bot)
TELEGRAM_BOT_TOKEN=

# NestJS Observe (opcional)
OBSERVE_APP_KEY=
OBSERVE_APP_SECRET=
```

Variables y valores predeterminados que usa el código:

| Variable | Obligatoria | Valor predeterminado | Uso |
|---|---:|---|---|
| `PORT` | No | `3000` | Puerto HTTP. |
| `DB_HOST` | No | `localhost` | Host PostgreSQL. |
| `DB_PORT` | No | `5432` | Puerto PostgreSQL. |
| `DB_NAME` | No | `systemdistrimagik` | Base de datos. |
| `DB_USER` | No | `agente_ia_lectura` | Usuario PostgreSQL. |
| `DB_PASSWORD` | Sí para conectarse | Sin valor | Contraseña del usuario de base de datos. |
| `TELEGRAM_BOT_TOKEN` | No | Sin valor | Si falta, Telegram no se inicia y se registra un error. |
| `OBSERVE_APP_KEY` | No | Marcador `YOUR_APP_KEY` | Clave de NestJS Observe. |
| `OBSERVE_APP_SECRET` | No | Marcador `YOUR_APP_SECRET` | Secreto de NestJS Observe. |

`.env` está excluido de Git. No guardes credenciales en el repositorio ni uses un usuario de base de datos con permisos de escritura para esta aplicación.

## Instalación y ejecución

Desde la raíz del repositorio:

```bash
corepack enable
pnpm install
```

Después de configurar `.env`, inicia el servidor:

```bash
# Desarrollo con recarga al cambiar archivos
pnpm run start:dev

# Desarrollo con depurador
pnpm run start:debug

# Inicio normal
pnpm run start
```

La aplicación escucha por defecto en `http://localhost:3000`. Las rutas disponibles se enumeran en [API HTTP](#api-http). No hay una ruta raíz `GET /` definida en `AppController`.

### Preparar Ollama

En la máquina donde se ejecuta la aplicación, inicia Ollama y descarga el modelo configurado en `src/ai/ai.service.ts`:

```bash
ollama serve
ollama pull qwen3.5:4b
```

La integración llama a `POST http://localhost:11434/api/chat`, no transmite respuestas en streaming y usa un timeout de 120 segundos. Si Ollama está en otro host o puerto, hay que cambiar la URL en `AiService`; no existe una variable de entorno para configurarla actualmente.

## API HTTP

La API no tiene prefijo global ni autenticación configurada en el código actual. Las respuestas y errores usan el formato estándar de NestJS.

### `GET /productos`

Devuelve hasta 30 filas de lotes activos con existencias. La búsqueda opcional se aplica al nombre del producto mediante coincidencia parcial, sin distinguir mayúsculas/minúsculas.

```bash
curl "http://localhost:3000/productos?buscar=esmalte"
```

Cada fila contiene:

```json
{
  "id": 123,
  "nombre": "Nombre del producto",
  "marca": "Marca",
  "categoria": "Categoría",
  "id_lote": 456,
  "stock": 10,
  "precio_1": "1000",
  "precio_2": "900",
  "precio_3": "800",
  "precio_4": "700"
}
```

Los valores reales dependen del catálogo. Como la consulta es por lote, un producto puede aparecer en más de una fila.

### `GET /cotizar`

Parámetros obligatorios:

- `id`: identificador entero positivo del producto.
- `cantidad`: cantidad entera positiva de unidades.

```bash
curl "http://localhost:3000/cotizar?id=123&cantidad=6"
```

Una cotización disponible devuelve el producto, la cantidad, el nivel de precio, el subtotal y el detalle por lote. Ejemplo de forma:

```json
{
  "disponible": true,
  "producto": {
    "id": 123,
    "nombre": "Nombre del producto",
    "marca": "Marca",
    "categoria": "Categoría"
  },
  "cantidad": 6,
  "nivelPrecio": 2,
  "subtotal": 5400,
  "detalle": [
    {
      "idLote": 456,
      "unidades": 6,
      "precioUnitario": 900,
      "subtotal": 5400
    }
  ],
  "requiereAprobacionAsesor": true
}
```

Si no hay lotes activos con existencias, responde `disponible: false` con un mensaje. Si la cantidad solicitada supera el stock total, también incluye el nombre del producto, la cantidad solicitada y el stock disponible. Una solicitud inválida produce HTTP 400. La ruta no modifica ni reserva inventario.

### `POST /chat`

Recibe JSON con `mensaje`, que debe contener entre 1 y 2000 caracteres después de quitar espacios en los extremos:

```bash
curl -X POST "http://localhost:3000/chat" \
  -H "Content-Type: application/json" \
  -d "{\"mensaje\":\"¿Tienen esmalte rojo y cuánto cuesta?\"}"
```

Respuesta:

```json
{
  "respuesta": "Respuesta del asistente basada en el catálogo disponible.",
  "productosConsultados": 1
}
```

El asistente normaliza el mensaje, extrae hasta cuatro términos de búsqueda, consulta el catálogo y limita el contexto a 12 resultados. Si no encuentra coincidencias, consulta el catálogo general. Las instrucciones del modelo indican responder en español, no inventar productos, marcas, precios o existencias y aclarar que los pedidos requieren aprobación.

Esta ruta no guarda historial entre solicitudes HTTP. Si Ollama no responde, devuelve HTTP 503.

## Bot de Telegram

El bot se inicia dentro del ciclo de vida de Nest solo si `TELEGRAM_BOT_TOKEN` está definido. Usa long polling; no requiere configurar un webhook ni exponer una URL pública. El bot maneja mensajes de texto.

Comandos disponibles:

| Comando | Comportamiento |
|---|---|
| `/start` | Mensaje de bienvenida. |
| `/ayuda` o `/help` | Muestra comandos e información sobre cotizaciones. |
| `/productos [nombre]` | Busca productos. Sin argumento pregunta qué producto buscar. |
| `/cotizar [nombre]` | Inicia una cotización guiada; acepta opcionalmente un término de búsqueda. |
| `/cancelar` | Cancela el flujo activo de búsqueda o cotización. |
| `/reiniciar` o `/reset` | Cancela el flujo y elimina el historial conversacional guardado para ese chat. |

El flujo de cotización pide el producto, presenta hasta 10 productos distintos para elegir mediante su número, solicita una cantidad entera positiva y muestra una cotización en pesos colombianos. El bot informa que la cotización queda pendiente de confirmación y no reserva existencias. También intenta reconocer expresiones de intención de compra y empieza el mismo flujo.

Los mensajes que no sean comandos ni parte de un flujo se envían a `AiService` junto con el historial del chat. El bot conserva hasta 20 mensajes (mensajes de usuario y respuestas del asistente) por chat. Los mensajes de Telegram se procesan en secuencia dentro de cada chat; chats distintos pueden procesarse independientemente. Las selecciones de producto y otros pasos temporales del flujo se guardan en memoria y se pierden cuando se reinicia el proceso.

## Base de datos y cotizaciones

No hay migraciones ni creación automática del esquema en este repositorio. La instancia debe tener estas tablas y columnas con los nombres exactos (incluidas mayúsculas y minúsculas):

- `public."PRODUCTOS"`: `"ID_Producto"`, `"Nombre"`, `"ID_Marca"`, `"ID_Categoria"`, `"Estado"`.
- `public."LOTES_PRODUCTO"`: `"ID_Lote"`, `"ID_Producto"`, `"Stock_actual"`, `"Precio_venta_1"` a `"Precio_venta_4"`, `"Estado"`.
- `public."MARCAS"`: `"ID_Marca"`, `"Nombre"`.
- `public."CATEGORIAS"`: `"ID_Categoria"`, `"Nombre"`.

El catálogo incluye solo productos activos (`PRODUCTOS.Estado = TRUE`) y lotes activos con stock positivo. Marca y categoría son opcionales. La aplicación ejecuta consultas de lectura y establece `default_transaction_read_only` durante la inicialización de la conexión; aun así, configura `DB_USER` con permisos explícitos de solo lectura y limita sus permisos a las tablas necesarias.

Los niveles de precio se determinan por la cantidad del mismo producto:

| Unidades | Campo de precio |
|---:|---|
| 1–5 | `Precio_venta_1` |
| 6–11 | `Precio_venta_2` |
| 12–23 | `Precio_venta_3` |
| 24 o más | `Precio_venta_4` |

El precio por nivel se elige con la cantidad total solicitada, no sumando unidades de productos diferentes. Si la cantidad se abastece con más de un lote, la consulta toma primero los lotes de menor `ID_Lote` y distribuye las unidades disponibles en ese orden. No existe una operación de reserva o creación de pedido.

## Historial de Telegram

El servicio crea y usa `data/telegram-conversations.json` en el directorio de trabajo actual. El archivo almacena un objeto cuyas claves son IDs de chat y cuyos valores son listas de mensajes:

```json
{
  "ID_DEL_CHAT": [
    { "role": "user", "content": "Mensaje del cliente" },
    { "role": "assistant", "content": "Respuesta del asistente" }
  ]
}
```

El archivo se carga al iniciar, se valida y se limita a los 20 mensajes más recientes por chat. Cada actualización se escribe primero en un archivo temporal y después se renombra al archivo definitivo. `.gitignore` excluye el historial y su archivo temporal: son datos potencialmente sensibles y no deben añadirse al repositorio. `/reset` y `/reiniciar` borran el historial de un chat.

## Pruebas, formato y compilación

```bash
# Pruebas unitarias
pnpm test

# Pruebas unitarias en modo watch
pnpm run test:watch

# Pruebas end-to-end
pnpm run test:e2e

# Cobertura
pnpm run test:cov

# Análisis estático
pnpm run lint

# Formatear los archivos TypeScript de src/ y test/
pnpm run format

# Compilar
pnpm run build
```

Vitest descubre pruebas `*.spec.ts`; el comando end-to-end usa `vitest.config.e2e.ts` y descubre `*.e2e-spec.ts`. Las pruebas actuales aún conservan expectativas de la plantilla NestJS: la prueba unitaria espera `getHello()` y la prueba end-to-end espera `GET /`, rutas que no están implementadas en el controlador actual. Además, la prueba unitaria no proporciona las dependencias `DatabaseService` y `AiService` del controlador. Actualiza estas pruebas antes de considerarlas una verificación del comportamiento actual.

## Despliegue y operación

Compila y ejecuta la salida de producción:

```bash
pnpm run build
pnpm run start:prod
```

En producción, inyecta las variables de entorno en el proceso y asegúrate de que tenga conectividad con PostgreSQL. El proceso también intenta iniciar el bot si se proporciona `TELEGRAM_BOT_TOKEN`. La URL de Ollama está codificada como `localhost`; en contenedores o despliegues separados, ese host debe ser accesible desde el proceso y puede requerir un cambio en `AiService`.

La aplicación crea `ObserveModule` para observabilidad de NestJS. Para habilitar la cuenta de Observe, configura `OBSERVE_APP_KEY` y `OBSERVE_APP_SECRET`; sin credenciales se usan valores marcadores.

## Solución de problemas

| Síntoma | Qué revisar |
|---|---|
| El servidor no inicia y aparece un error de conexión con PostgreSQL | Comprueba `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, conectividad de red y permisos de lectura. |
| Telegram no responde, pero la API HTTP está disponible | Revisa que `TELEGRAM_BOT_TOKEN` esté definido y que el token sea válido; revisa los logs del proceso y que la salida de red permita long polling. |
| `/chat` devuelve 503 | Comprueba que Ollama esté ejecutándose en el mismo host/entorno, que `qwen3.5:4b` esté descargado y que responda en `http://localhost:11434`. |
| No aparecen productos | Verifica que el esquema use los nombres de tablas/columnas indicados, que los productos y lotes estén activos y que el stock sea mayor que cero. |
| El proceso no puede cargar el historial de Telegram | Verifica que `data/telegram-conversations.json` contenga JSON válido con un objeto de historiales y mensajes con `role` (`user` o `assistant`) y `content` de tipo texto. |
