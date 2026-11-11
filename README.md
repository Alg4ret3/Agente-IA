# LadyNail Shop Agent

Backend en NestJS para consultar el catálogo de LadyNail Shop, preparar cotizaciones y responder consultas de clientes desde una API HTTP y WhatsApp mediante OpenWA. El asistente utiliza un modelo de Ollama y solo debe presentar como información comercial aquello que obtiene del catálogo de PostgreSQL.

## Contenido

- [Qué hace](#qué-hace)
- [Tecnologías](#tecnologías)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Requisitos y configuración](#requisitos-y-configuración)
- [Instalación y ejecución](#instalación-y-ejecución)
- [API HTTP](#api-http)
- [Canal de WhatsApp](#canal-de-whatsapp)
- [Base de datos y cotizaciones](#base-de-datos-y-cotizaciones)
- [Historial de WhatsApp](#historial-de-whatsapp)
- [Pruebas, formato y compilación](#pruebas-formato-y-compilación)
- [Despliegue y operación](#despliegue-y-operación)
- [Solución de problemas](#solución-de-problemas)

## Qué hace

La aplicación ofrece tres operaciones HTTP:

1. Buscar productos activos con existencias.
2. Cotizar un producto para una cantidad solicitada.
3. Enviar una consulta comercial al asistente, que combina el mensaje con resultados del catálogo y los consulta a Ollama.

WhatsApp es el único canal de mensajería: OpenWA entrega los mensajes entrantes al webhook del backend y el backend envía las respuestas por la API de OpenWA. El asistente puede buscar productos, cotizar y armar pedidos que se guardan y envían al asesor para aprobación. Ninguna cotización reserva inventario ni confirma una venta.

## Tecnologías

- Node.js y TypeScript (módulos ES).
- NestJS 12 para la aplicación HTTP y la inyección de dependencias.
- PostgreSQL mediante `pg`.
- Ollama mediante su API HTTP local.
- WhatsApp mediante la API HTTP de OpenWA y webhooks firmados.
- pnpm para instalar dependencias.
- Vitest para pruebas y Oxlint para análisis estático.

## Estructura del proyecto

```text
.
├── data/
│   ├── whatsapp-conversations.json   # Historial local; no versionar
│   └── whatsapp-orders.json          # Pedidos locales; no versionar
├── src/
│   ├── ai/
│   │   ├── ai.module.ts
│   │   └── ai.service.ts             # Búsqueda de contexto y comunicación con Ollama
│   ├── database/
│   │   ├── database.module.ts
│   │   ├── database.service.ts       # Pool PostgreSQL, catálogo y cotizaciones
│   │   └── database.service.spec.ts
│   ├── whatsapp/
│   │   ├── whatsapp.controller.ts    # Webhook firmado de OpenWA
│   │   ├── whatsapp.module.ts
│   │   └── whatsapp.service.ts       # Mensajes, OpenWA, flujos e historial
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
└── WhatsAppModule ──┬──────────────┘
                     ├── AiModule
                     └── DatabaseModule

AppController ──> AiService
              └─> DatabaseService

AiService ──────> DatabaseService ──> PostgreSQL
WhatsAppService ─> AiService
                └> DatabaseService
```

- **`DatabaseModule`** configura `ConfigModule` como global y exporta `DatabaseService`.
- **`DatabaseService`** administra el pool de conexiones, busca productos y calcula cotizaciones. Cierra el pool al detener Nest.
- **`AiModule` / `AiService`** construyen el contexto del catálogo y llaman a Ollama. El módulo exporta el servicio para la API y WhatsApp.
- **`WhatsAppModule` / `WhatsAppService`** reciben los webhooks firmados de OpenWA, procesan mensajes en serie por chat, llaman a la API de envío y guardan el historial local.
- **`AppController`** expone las rutas HTTP.
- **`main.ts`** crea la aplicación y escucha en `PORT` o, si no está definido, en el puerto `3000`.

## Requisitos y configuración

Se necesita:

- Node.js 20.19 o posterior.
- pnpm y acceso a los paquetes del lockfile.
- Una instancia PostgreSQL con el esquema y los datos del catálogo descritos más abajo.
- Ollama disponible en `http://localhost:11434` y el modelo `qwen3.5:4b` descargado. Ollama solo es necesario para la ruta `/chat` y las respuestas conversacionales de WhatsApp.
- OpenWA disponible por HTTP, con una sesión de WhatsApp iniciada y su API key configurada.

Crea un archivo `.env` en la raíz del proyecto. No se distribuye una plantilla de entorno; usa este ejemplo y reemplaza los valores según el entorno:

```dotenv
# Servidor HTTP
PORT=3000
OLLAMA_MODEL=qwen3.5:4b

# PostgreSQL
DB_HOST=localhost
DB_PORT=5432
DB_NAME=systemdistrimagik
DB_USER=agente_ia_lectura
DB_PASSWORD=cambia_este_valor

# OpenWA / WhatsApp
OPENWA_BASE_URL=http://localhost:2785
OPENWA_API_KEY=
OPENWA_SESSION_ID=
OPENWA_WEBHOOK_SECRET=
OPENWA_ADVISOR_PHONE=
WHATSAPP_ORDERS_FILE=data/whatsapp-orders.json

# Whisper local (servidor compatible con OpenAI; configurar por separado)
WHISPER_API_URL=http://localhost:8000/v1/audio/transcriptions
WHISPER_MODEL=Systran/faster-whisper-small
WHISPER_API_KEY=

# NestJS Observe (opcional)
OBSERVE_APP_KEY=
OBSERVE_APP_SECRET=
```

Variables y valores predeterminados que usa el código:

| Variable                |              Obligatoria | Valor predeterminado                            | Uso                                                                 |
| ----------------------- | -----------------------: | ----------------------------------------------- | ------------------------------------------------------------------- |
| `PORT`                  |                       No | `3000`                                          | Puerto HTTP.                                                        |
| `OLLAMA_MODEL`          |                       No | `qwen3.5:4b`                                    | Modelo local usado para respuestas conversacionales.                |
| `DB_HOST`               |                       No | `localhost`                                     | Host PostgreSQL.                                                    |
| `DB_PORT`               |                       No | `5432`                                          | Puerto PostgreSQL.                                                  |
| `DB_NAME`               |                       No | `systemdistrimagik`                             | Base de datos.                                                      |
| `DB_USER`               |                       No | `agente_ia_lectura`                             | Usuario PostgreSQL.                                                 |
| `DB_PASSWORD`           |       Sí para conectarse | Sin valor                                       | Contraseña del usuario de base de datos.                            |
| `OPENWA_BASE_URL`       |                       No | `http://localhost:2785`                         | URL base de la API de OpenWA.                                       |
| `OPENWA_API_KEY`        |         Sí para WhatsApp | Sin valor                                       | API key de OpenWA; se envía en el header `X-API-Key`.               |
| `OPENWA_SESSION_ID`     |         Sí para WhatsApp | Sin valor                                       | ID de la sesión de OpenWA que recibirá y enviará mensajes.          |
| `OPENWA_WEBHOOK_SECRET` |         Sí para WhatsApp | Sin valor                                       | Secreto compartido para verificar `X-OpenWA-Signature`.             |
| `OPENWA_ADVISOR_PHONE`  | Sí para avisos y pedidos | Sin valor                                       | Número internacional del asesor, solo dígitos, sin `+`.             |
| `WHATSAPP_ORDERS_FILE`  |                       No | `data/whatsapp-orders.json`                     | Archivo local de pedidos pendientes y su estado.                    |
| `WHISPER_API_URL`       |     Sí para notas de voz | `http://localhost:8000/v1/audio/transcriptions` | Endpoint local compatible con la API de transcripciones de OpenAI.  |
| `WHISPER_MODEL`         |                       No | `Systran/faster-whisper-small`                  | Nombre de modelo cargado por el servidor Whisper local.             |
| `WHISPER_API_KEY`       |                       No | Sin valor                                       | Token opcional si el servidor local de Whisper exige autenticación. |
| `OBSERVE_APP_KEY`       |                       No | Marcador `YOUR_APP_KEY`                         | Clave de NestJS Observe.                                            |
| `OBSERVE_APP_SECRET`    |                       No | Marcador `YOUR_APP_SECRET`                      | Secreto de NestJS Observe.                                          |

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

El asistente responde saludos comunes sin llamar al modelo, busca hasta tres términos en paralelo y limita el contexto a 12 productos. No envía precios ni existencias al modelo; para precios, pide la cantidad y orienta al cliente a `/cotizar`. Las respuestas de Ollama tienen un máximo configurado de 128 tokens y un tiempo límite de 45 segundos. Si no encuentra coincidencias, no carga el catálogo completo.

Esta ruta no guarda historial entre solicitudes HTTP. Si Ollama no responde, devuelve HTTP 503.

## Canal de WhatsApp

OpenWA debe poder acceder a `POST http://localhost:3000/openwa/webhook`. Si el backend usa otro puerto o host, configura en OpenWA la URL que realmente pueda alcanzar. Crea el webhook para la sesión cuyo ID se haya puesto en `OPENWA_SESSION_ID`, suscrito a `message.received` y `call.received`, y configura como `secret` el mismo valor de `OPENWA_WEBHOOK_SECRET`. OpenWA firma el cuerpo original con `X-OpenWA-Signature: sha256=<hex>`; el backend rechaza firmas ausentes o inválidas.

Usa en `OPENWA_SESSION_ID` el `sessionId` del evento entrante. Si el mensaje llega con un identificador `@lid`, el backend consulta OpenWA para resolverlo a un número antes de enviar la respuesta y, si no hay mapeo disponible, intenta responder al mismo `@lid`. La API puede bloquear URLs de webhook por su política SSRF; si OpenWA rechaza `localhost`, configura una dirección interna alcanzable y permitida por OpenWA, sin desactivar esa protección.

Ejemplo para crear el webhook desde OpenWA (sustituye los marcadores; no guardes la API key en el repositorio):

```bash
curl -X POST "http://localhost:2785/api/sessions/ID_DE_SESION/webhooks" \
  -H "X-API-Key: TU_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"http://localhost:3000/openwa/webhook\",\"events\":[\"message.received\",\"call.received\"],\"secret\":\"EL_MISMO_OPENWA_WEBHOOK_SECRET\",\"retryCount\":3}"
```

El backend procesa mensajes de texto, notas de voz e imágenes individuales; ignora mensajes propios, grupos y estados. Para mensajes entrantes llama a `POST /api/sessions/{sessionId}/chats/read`, incluyendo el ID específico del mensaje cuando OpenWA lo proporciona, para emitir la confirmación de lectura de WhatsApp. Si la persona tiene desactivadas las confirmaciones de lectura en su privacidad, WhatsApp puede no mostrar los ticks azules. Las notas de voz se descargan desde OpenWA, se transcriben con un servidor local compatible con OpenAI Whisper y luego pasan por el mismo asistente. Las imágenes se reenvían al asesor por WhatsApp con el número del cliente en el texto adjunto; se admiten archivos de hasta 10 MB. Si OpenWA no permite descargar o reenviar la imagen, el asesor recibe un aviso con el número del cliente para revisar el chat original. Las respuestas se envían a `POST /api/sessions/{sessionId}/messages/send-text` usando `X-API-Key` y una clave de idempotencia derivada del evento recibido. El servidor de transcripción se instala y ejecuta localmente; si no está disponible o el audio supera 20 MB, el cliente recibe un aviso para volver a intentar o escribir su consulta.

Para activar la transcripción con Speaches, inicia Docker Desktop y ejecuta en PowerShell:

```powershell
docker run --rm --detach --publish 127.0.0.1:8000:8000 --name speaches --volume speaches-model-cache:/home/ubuntu/.cache/huggingface/hub ghcr.io/speaches-ai/speaches:latest-cpu
```

La primera transcripción descarga el modelo indicado en `WHISPER_MODEL`. Este servicio, basado en Whisper, se ejecuta localmente, separado del backend y de Ollama; no requiere enviar los audios a la nube. Si el servidor no está disponible, el cliente recibe un aviso para volver a intentar o escribir su consulta. Consulta la [guía de instalación de Speaches](https://speaches.ai/installation/) para alternativas con GPU y requisitos adicionales.

OpenWA también debe tener habilitado el evento `call.received`. La opción `autoRejectCalls` y el endpoint de rechazo de llamadas solo funcionan con el motor Baileys; `whatsapp-web.js` no permite rechazar llamadas. El backend solicita el rechazo al recibir el evento y envía un aviso al asesor mediante `OPENWA_ADVISOR_PHONE`. Para incluir el número real, consulta la ficha del contacto de OpenWA cuando el evento trae un ID `@lid`. Si el motor activo no permite rechazar llamadas, el aviso lo indica explícitamente y pide contactar pronto al cliente. Esto no transfiere la llamada en vivo.

Comandos disponibles:

| Comando                       | Comportamiento                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `/start`                      | Mensaje de bienvenida.                                                            |
| `/ayuda` o `/help`            | Muestra comandos e información sobre cotizaciones.                                |
| `/productos [nombre]`         | Busca productos. Sin argumento pregunta qué producto buscar.                      |
| `/cotizar [nombre]`           | Inicia una cotización guiada; acepta opcionalmente un término de búsqueda.        |
| `/pedido`                     | Busca productos, recopila cantidades y datos del cliente y solicita confirmación. |
| `/pedido aprobar [código]`    | Aprueba un pedido (solo asesor).                                                  |
| `/pedido cambios [código]`    | Marca que se requieren cambios (solo asesor).                                     |
| `/pedido reintentar [código]` | Reintenta la entrega pendiente de un pedido (solo cliente titular).               |
| `/pedido estado [código]`     | Consulta el estado (solo cliente titular o asesor).                               |
| `/cancelar`                   | Cancela el flujo activo de búsqueda, cotización o pedido.                         |
| `/reiniciar` o `/reset`       | Cancela el flujo y elimina el historial conversacional guardado para ese chat.    |

El flujo de cotización pide el producto, presenta hasta 10 productos distintos para elegir mediante su número, solicita una cantidad entera positiva y muestra una cotización en pesos colombianos. El flujo `/pedido` admite varios productos y valida cantidades, nombre, celular, dirección y cédula opcional; calcula los totales desde PostgreSQL y vuelve a cotizar antes de aceptar la confirmación final. Luego guarda el pedido localmente y lo envía al asesor con un código. El cliente recibe un aviso de que todavía requiere aprobación; el asesor puede aprobarlo o marcar cambios con los comandos anteriores. También intenta reconocer expresiones de intención de compra y empieza el flujo de pedido.

Los carritos entrantes se detectan en eventos `message.received` u `order.received` cuando OpenWA entrega `productItems` o `products` con nombre y cantidad, directamente o dentro de `orderMessage`. Cada nombre debe coincidir exactamente con un único producto del catálogo y cada cantidad se vuelve a cotizar; se ignoran los precios y totales del mensaje de WhatsApp. Si algún producto no coincide, está ambiguo o no está disponible, el bot no crea pedido y pide usar `/pedido` o contactar al asesor. Los carritos válidos requieren una confirmación para iniciar el flujo de captura de datos y otra confirmación final antes de guardarse y enviarse al asesor.

Los mensajes que no sean comandos ni parte de un flujo se envían a `AiService` junto con hasta ocho mensajes recientes del historial. Los mensajes de WhatsApp se procesan en secuencia dentro de cada chat; chats distintos pueden procesarse independientemente. Los borradores de conversación se guardan en memoria y se pierden al reiniciar el proceso. Los pedidos confirmados se conservan en `WHATSAPP_ORDERS_FILE`; este archivo contiene datos personales, está excluido de Git y debe protegerse con permisos del sistema operativo y copias seguras. El almacenamiento es local a una instancia y no sincroniza pedidos entre varias réplicas.

## Base de datos y cotizaciones

No hay migraciones ni creación automática del esquema en este repositorio. La instancia debe tener estas tablas y columnas con los nombres exactos (incluidas mayúsculas y minúsculas):

- `public."PRODUCTOS"`: `"ID_Producto"`, `"Nombre"`, `"ID_Marca"`, `"ID_Categoria"`, `"Estado"`.
- `public."LOTES_PRODUCTO"`: `"ID_Lote"`, `"ID_Producto"`, `"Stock_actual"`, `"Precio_venta_1"` a `"Precio_venta_4"`, `"Estado"`.
- `public."MARCAS"`: `"ID_Marca"`, `"Nombre"`.
- `public."CATEGORIAS"`: `"ID_Categoria"`, `"Nombre"`.

El catálogo incluye solo productos activos (`PRODUCTOS.Estado = TRUE`) y lotes activos con stock positivo. Marca y categoría son opcionales. La aplicación ejecuta consultas de lectura y establece `default_transaction_read_only` durante la inicialización de la conexión; aun así, configura `DB_USER` con permisos explícitos de solo lectura y limita sus permisos a las tablas necesarias. Los pedidos se guardan en el archivo local configurado en `WHATSAPP_ORDERS_FILE`, por lo que la aplicación no necesita permisos de escritura en PostgreSQL.

Los niveles de precio se determinan por la cantidad del mismo producto:

| Unidades | Campo de precio  |
| -------: | ---------------- |
|      1–5 | `Precio_venta_1` |
|     6–11 | `Precio_venta_2` |
|    12–23 | `Precio_venta_3` |
| 24 o más | `Precio_venta_4` |

El precio por nivel se elige con la cantidad total solicitada, no sumando unidades de productos diferentes. Si la cantidad se abastece con más de un lote, la consulta toma primero los lotes de menor `ID_Lote` y distribuye las unidades disponibles en ese orden. No existe una operación de reserva o creación de pedido.

## Historial de WhatsApp

El servicio crea y usa `data/whatsapp-conversations.json` en el directorio de trabajo actual. El archivo almacena un objeto cuyas claves son IDs de chat y cuyos valores son listas de mensajes:

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

En producción, inyecta las variables de entorno en el proceso y asegúrate de que tenga conectividad con PostgreSQL y OpenWA. Configura la URL del webhook para que OpenWA alcance el backend; `localhost` solo funciona si ambos procesos comparten el mismo host o red. La URL de Ollama está codificada como `localhost`; en contenedores o despliegues separados, ese host debe ser accesible desde el proceso y puede requerir un cambio en `AiService`.

La aplicación crea `ObserveModule` para observabilidad de NestJS. Para habilitar la cuenta de Observe, configura `OBSERVE_APP_KEY` y `OBSERVE_APP_SECRET`; sin credenciales se usan valores marcadores.

## Solución de problemas

| Síntoma                                                             | Qué revisar                                                                                                                                                                  |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| El servidor no inicia y aparece un error de conexión con PostgreSQL | Comprueba `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, conectividad de red y permisos de lectura.                                                              |
| WhatsApp no responde, pero la API HTTP está disponible              | Revisa `OPENWA_BASE_URL`, `OPENWA_API_KEY`, `OPENWA_SESSION_ID` y `OPENWA_WEBHOOK_SECRET`; confirma que la sesión esté iniciada y que el webhook apunte a `/openwa/webhook`. |
| OpenWA recibe errores al entregar el webhook                        | Comprueba que OpenWA pueda acceder al backend y que el secreto configurado coincida; el webhook debe enviar el cuerpo original y el header `X-OpenWA-Signature`.             |
| `/chat` devuelve 503                                                | Comprueba que Ollama esté ejecutándose en el mismo host/entorno, que `qwen3.5:4b` esté descargado y que responda en `http://localhost:11434`.                                |
| No aparecen productos                                               | Verifica que el esquema use los nombres de tablas/columnas indicados, que los productos y lotes estén activos y que el stock sea mayor que cero.                             |
| El proceso no puede cargar el historial de WhatsApp                 | Verifica que `data/whatsapp-conversations.json` contenga JSON válido con un objeto de historiales y mensajes con `role` (`user` o `assistant`) y `content` de tipo texto.    |
