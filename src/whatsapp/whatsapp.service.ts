import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { AiService, type ConversationMessage } from '../ai/ai.service.js';
import { DatabaseService } from '../database/database.service.js';

type CatalogProduct = {
  id: number;
  nombre: string;
  marca: string | null;
  categoria: string | null;
};

type ConversationFlow =
  | { step: 'product_search' }
  | { step: 'quote_search' }
  | { step: 'select_product'; products: CatalogProduct[] }
  | { step: 'quantity'; product: CatalogProduct };

@Injectable()
export class WhatsAppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly historyPath = resolve(
    process.cwd(),
    'data',
    'whatsapp-conversations.json',
  );
  private readonly histories = new Map<string, ConversationMessage[]>();
  private readonly flows = new Map<string, ConversationFlow>();
  private readonly chatQueues = new Map<string, Promise<void>>();
  private readonly inFlightEvents = new Map<string, Promise<void>>();
  private readonly processedEvents = new Set<string>();
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly openWaUrl: string;
  private readonly openWaApiKey: string;
  private readonly sessionId: string;
  private readonly webhookSecret: string;
  private readonly advisorPhone: string;
  private readonly whisperApiUrl: string;
  private readonly whisperApiKey: string;
  private readonly whisperModel: string;

  constructor(
    private readonly config: ConfigService,
    private readonly ai: AiService,
    private readonly database: DatabaseService,
  ) {
    this.openWaUrl =
      this.config.get<string>('OPENWA_BASE_URL') ?? 'http://localhost:2785';
    this.openWaApiKey = this.config.get<string>('OPENWA_API_KEY') ?? '';
    this.sessionId = this.config.get<string>('OPENWA_SESSION_ID') ?? '';
    this.webhookSecret = this.config.get<string>('OPENWA_WEBHOOK_SECRET') ?? '';
    this.advisorPhone =
      this.config.get<string>('OPENWA_ADVISOR_PHONE')?.replace(/\D/g, '') ?? '';
    this.whisperApiUrl =
      this.config.get<string>('WHISPER_API_URL') ??
      'http://localhost:8000/v1/audio/transcriptions';
    this.whisperApiKey = this.config.get<string>('WHISPER_API_KEY') ?? '';
    this.whisperModel =
      this.config.get<string>('WHISPER_MODEL') ??
      'Systran/faster-whisper-small';
  }

  async onModuleInit() {
    await this.loadHistories();

    if (!this.openWaApiKey || !this.sessionId || !this.webhookSecret) {
      this.logger.error(
        'Configura OPENWA_API_KEY, OPENWA_SESSION_ID y OPENWA_WEBHOOK_SECRET para habilitar WhatsApp.',
      );
      return;
    }

    this.logger.log('Canal de WhatsApp listo para recibir eventos de OpenWA.');
  }

  async onModuleDestroy() {
    await Promise.all(this.chatQueues.values());
    await this.writeQueue;
  }

  private async loadHistories(): Promise<void> {
    await mkdir(dirname(this.historyPath), { recursive: true });

    let contents: string;
    try {
      contents = await readFile(this.historyPath, 'utf8');
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return;
      }
      throw error;
    }

    const parsed: unknown = JSON.parse(contents);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        'El archivo de historial de WhatsApp tiene un formato inválido.',
      );
    }

    for (const [chatId, history] of Object.entries(parsed)) {
      if (
        !Array.isArray(history) ||
        !history.every(
          (message): message is ConversationMessage =>
            message !== null &&
            typeof message === 'object' &&
            (message.role === 'user' || message.role === 'assistant') &&
            typeof message.content === 'string',
        )
      ) {
        throw new Error(
          `El historial almacenado para el chat ${chatId} tiene un formato inválido.`,
        );
      }

      this.histories.set(chatId, history.slice(-20));
    }

    this.logger.log(
      'Historiales de WhatsApp cargados desde el almacenamiento local.',
    );
  }

  async handleIncomingEvent(
    event: unknown,
    rawBody: Buffer,
    signature: string | undefined,
  ): Promise<{ accepted: boolean }> {
    if (!this.openWaApiKey || !this.sessionId || !this.webhookSecret) {
      throw new ServiceUnavailableException(
        'El canal de WhatsApp no está configurado.',
      );
    }

    this.verifySignature(rawBody, signature);

    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new BadRequestException('El evento de OpenWA no es válido.');
    }

    const payload = event as Record<string, unknown>;
    const data =
      payload.data && typeof payload.data === 'object'
        ? (payload.data as Record<string, unknown>)
        : undefined;

    if (payload.sessionId !== this.sessionId || !data) {
      return { accepted: false };
    }

    const eventKey =
      typeof payload.idempotencyKey === 'string'
        ? payload.idempotencyKey
        : typeof data.id === 'string'
          ? data.id
          : undefined;

    if (!eventKey) return { accepted: false };
    if (this.processedEvents.has(eventKey)) return { accepted: true };

    const inFlight = this.inFlightEvents.get(eventKey);
    if (inFlight) return { accepted: true };

    let processEvent: Promise<void>;
    if (payload.event === 'call.received') {
      processEvent = this.handleIncomingCall(data, eventKey);
    } else if (
      payload.event === 'message.received' &&
      data.fromMe === false &&
      data.isGroup === false &&
      data.isStatusBroadcast !== true &&
      typeof data.chatId === 'string'
    ) {
      if (
        data.type === 'text' &&
        typeof data.body === 'string' &&
        data.body.trim()
      ) {
        processEvent = this.enqueueMessage(
          data.chatId,
          data.body.trim(),
          eventKey,
        );
      } else if (this.isVoiceMessageType(data.type)) {
        processEvent = this.enqueueVoiceMessage(data, eventKey);
      } else {
        return { accepted: false };
      }
    } else {
      return { accepted: false };
    }

    const processing = processEvent
      .then(() => {
        this.processedEvents.add(eventKey);
        if (this.processedEvents.size > 1000) {
          const oldest = this.processedEvents.values().next().value;
          if (oldest) this.processedEvents.delete(oldest);
        }
      })
      .catch((error: unknown) => {
        this.logger.error(
          'No fue posible completar el evento de WhatsApp.',
          error instanceof Error ? error.stack : undefined,
        );
      })
      .finally(() => this.inFlightEvents.delete(eventKey));
    this.inFlightEvents.set(eventKey, processing);

    return { accepted: true };
  }

  private isVoiceMessageType(type: unknown): boolean {
    return type === 'audio' || type === 'ptt' || type === 'voice';
  }

  private async handleIncomingCall(
    data: Record<string, unknown>,
    eventKey: string,
  ): Promise<void> {
    const callId =
      typeof data.callId === 'string'
        ? data.callId
        : typeof data.id === 'string'
          ? data.id
          : undefined;

    if (!callId) {
      throw new BadRequestException(
        'OpenWA envió una llamada entrante sin identificador.',
      );
    }

    let rejectionNotice = 'La llamada entrante fue rechazada automáticamente.';
    try {
      const response = await fetch(
        `${this.openWaUrl.replace(/\/+$/, '')}/api/sessions/${encodeURIComponent(this.sessionId)}/calls/${encodeURIComponent(callId)}/reject`,
        {
          method: 'POST',
          headers: { 'X-API-Key': this.openWaApiKey },
          signal: AbortSignal.timeout(10_000),
        },
      );

      if (response.status === 404) {
        rejectionNotice = 'La llamada ya no estaba sonando cuando se procesó.';
      } else if (response.status === 501) {
        rejectionNotice =
          'OpenWA no pudo rechazar la llamada con el motor actual. Contacta al cliente cuanto antes.';
      } else if (!response.ok) {
        rejectionNotice = `OpenWA no pudo confirmar el rechazo (HTTP ${response.status}). Contacta al cliente cuanto antes.`;
      }
    } catch (error) {
      rejectionNotice =
        'No fue posible confirmar el rechazo por un error de conexión con OpenWA. Contacta al cliente cuanto antes.';
      this.logger.error(
        'No fue posible rechazar la llamada entrante.',
        error instanceof Error ? error.stack : undefined,
      );
    }

    if (!this.advisorPhone) {
      this.logger.error(
        'La llamada fue rechazada, pero OPENWA_ADVISOR_PHONE no está configurado; no se pudo avisar al asesor.',
      );
      return;
    }

    const caller =
      typeof data.from === 'string'
        ? data.from
        : typeof data.chatId === 'string'
          ? data.chatId
          : 'número no disponible';
    await this.sendMessage(
      `${this.advisorPhone}@c.us`,
      `${rejectionNotice}\nContacto: ${caller}\nRevisa el chat para responderle.`,
      `${eventKey}:advisor`,
    );
  }

  private async enqueueVoiceMessage(
    data: Record<string, unknown>,
    eventKey: string,
  ): Promise<void> {
    if (
      typeof data.chatId !== 'string' ||
      typeof data.id !== 'string' ||
      !data.id
    ) {
      throw new BadRequestException(
        'OpenWA envió un audio sin identificador de chat o mensaje.',
      );
    }

    const chatId = data.chatId;
    const messageId = data.id;
    const previous = this.chatQueues.get(chatId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        const transcript = await this.transcribeVoiceMessage(chatId, messageId);
        if (!transcript) {
          await this.sendMessage(
            chatId,
            'No logré entender el audio. ¿Puedes repetirlo o enviarme tu consulta por escrito?',
            `${eventKey}:empty-transcript`,
          );
          return;
        }

        await this.processMessage(chatId, transcript, (message) =>
          this.sendMessage(chatId, message, `${eventKey}:${message}`),
        );
      })
      .catch(async (error: unknown) => {
        this.logger.error(
          'No fue posible transcribir el audio de WhatsApp.',
          error instanceof Error ? error.stack : undefined,
        );
        await this.sendMessage(
          chatId,
          'Por el momento no pude procesar la nota de voz. Inténtalo de nuevo o escríbeme tu consulta.',
          `${eventKey}:transcription-error`,
        );
      })
      .finally(() => {
        if (this.chatQueues.get(chatId) === current) {
          this.chatQueues.delete(chatId);
        }
      });

    this.chatQueues.set(chatId, current);
    await current;
  }

  private async transcribeVoiceMessage(
    chatId: string,
    messageId: string,
  ): Promise<string> {
    const mediaUrl =
      `${this.openWaUrl.replace(/\/+$/, '')}/api/sessions/${encodeURIComponent(this.sessionId)}` +
      `/messages/${encodeURIComponent(chatId)}/${encodeURIComponent(messageId)}/media`;
    const mediaResponse = await fetch(mediaUrl, {
      headers: { 'X-API-Key': this.openWaApiKey },
      signal: AbortSignal.timeout(30_000),
    });

    if (!mediaResponse.ok) {
      throw new Error(
        `OpenWA no pudo descargar el audio (HTTP ${mediaResponse.status}).`,
      );
    }

    const mediaType =
      mediaResponse.headers.get('content-type')?.split(';')[0] ??
      'application/octet-stream';
    if (
      !mediaType.startsWith('audio/') &&
      mediaType !== 'application/octet-stream'
    ) {
      throw new Error('OpenWA devolvió un archivo que no es de audio.');
    }

    const bytes = await mediaResponse.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > 20 * 1024 * 1024) {
      throw new Error('El audio está vacío o supera el límite de 20 MB.');
    }

    const extensions: Record<string, string> = {
      'audio/ogg': 'ogg',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'audio/webm': 'webm',
      'audio/wav': 'wav',
      'audio/amr': 'amr',
      'application/octet-stream': 'ogg',
    };
    const file = new File(
      [bytes],
      `whatsapp-voice.${extensions[mediaType] ?? 'ogg'}`,
      { type: mediaType },
    );
    const form = new FormData();
    form.append('file', file);
    form.append('model', this.whisperModel);
    form.append('language', 'es');

    const headers = this.whisperApiKey
      ? { Authorization: `Bearer ${this.whisperApiKey}` }
      : undefined;
    const transcriptionResponse = await fetch(this.whisperApiUrl, {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (!transcriptionResponse.ok) {
      throw new Error(
        `El servicio local de Whisper devolvió HTTP ${transcriptionResponse.status}.`,
      );
    }

    const result: unknown = await transcriptionResponse.json();
    if (
      !result ||
      typeof result !== 'object' ||
      !('text' in result) ||
      typeof result.text !== 'string'
    ) {
      throw new Error('Whisper devolvió una transcripción inválida.');
    }

    return result.text.trim();
  }

  private verifySignature(
    rawBody: Buffer,
    signature: string | undefined,
  ): void {
    const match = signature?.match(/^sha256=([a-f\d]{64})$/i);
    if (!match) {
      throw new UnauthorizedException('Firma de OpenWA ausente o inválida.');
    }

    const expected = createHmac('sha256', this.webhookSecret)
      .update(rawBody)
      .digest();
    const received = Buffer.from(match[1]!, 'hex');

    if (!timingSafeEqual(expected, received)) {
      throw new UnauthorizedException('Firma de OpenWA ausente o inválida.');
    }
  }

  private async enqueueMessage(
    chatId: string,
    texto: string,
    idempotencyKey: string,
  ): Promise<void> {
    const key = chatId;
    const previous = this.chatQueues.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => {
        let replyIndex = 0;
        return this.processMessage(chatId, texto, (message) =>
          this.sendMessage(
            chatId,
            message,
            `${idempotencyKey}:${replyIndex++}`,
          ),
        );
      })
      .catch((error: unknown) => {
        this.logger.error(
          'Error inesperado procesando el mensaje de WhatsApp.',
          error instanceof Error ? error.stack : undefined,
        );
        throw error;
      });
    this.chatQueues.set(key, current);

    try {
      await current;
    } finally {
      if (this.chatQueues.get(key) === current) {
        this.chatQueues.delete(key);
      }
    }
  }

  private async processMessage(
    chatId: string,
    texto: string,
    reply: (message: string) => Promise<void>,
  ): Promise<void> {
    try {
      const [command, ...commandArgs] = texto.split(/\s+/);
      const argument = commandArgs.join(' ').trim();

      if (command === '/start') {
        await reply(
          '¡Hola! Bienvenido a Distri Magik 💅\n\n' +
            'Puedo ayudarte a buscar productos y preparar cotizaciones.\n' +
            'Escribe /ayuda para ver las opciones.',
        );
        return;
      }

      if (command === '/help' || command === '/ayuda') {
        await reply(this.mensajeAyuda);
        return;
      }

      if (command === '/reset' || command === '/reiniciar') {
        this.flows.delete(chatId);
        await this.clearHistory(chatId);
        await reply('Listo, borré el contexto de esta conversación.');
        return;
      }

      if (command === '/cancelar') {
        this.flows.delete(chatId);
        await reply('Listo, cancelé el proceso actual.');
        return;
      }

      if (command === '/productos') {
        this.flows.set(chatId, { step: 'product_search' });
        if (argument) {
          await this.buscarProductos(reply, chatId, argument, false);
        } else {
          await reply('¿Qué producto estás buscando?');
        }
        return;
      }

      if (command === '/cotizar') {
        this.flows.set(chatId, { step: 'quote_search' });
        if (argument) {
          await this.buscarProductos(reply, chatId, argument, true);
        } else {
          await reply(
            '¿Qué producto y cantidad quieres cotizar? Primero dime el nombre del producto.',
          );
        }
        return;
      }

      const flow = this.flows.get(chatId);
      if (flow) {
        await this.continuarFlujo(reply, chatId, texto, flow);
        return;
      }

      if (this.esIntencionDePedido(texto)) {
        this.flows.set(chatId, { step: 'quote_search' });
        await reply(
          'Con gusto te ayudo a preparar la cotización. ¿Qué producto deseas cotizar? Después te preguntaré la cantidad.',
        );
        return;
      }

      const historial = this.histories.get(chatId) ?? [];
      const resultado = await this.ai.responder(texto, historial);

      await this.saveExchange(chatId, texto, resultado.respuesta);
      await reply(resultado.respuesta);
    } catch (error) {
      this.logger.error(
        'No fue posible procesar el mensaje de WhatsApp.',
        error instanceof Error ? error.stack : undefined,
      );

      try {
        await reply(
          'En este momento no puedo procesar tu consulta. Inténtalo nuevamente en unos minutos.',
        );
      } catch (sendError) {
        this.logger.error(
          'No fue posible enviar el mensaje de error de WhatsApp.',
          sendError instanceof Error ? sendError.stack : undefined,
        );
        throw sendError;
      }
    }
  }

  private async saveExchange(
    chatId: string,
    userMessage: string,
    assistantMessage: string,
  ): Promise<void> {
    const previousHistory = this.histories.get(chatId) ?? [];
    const updatedHistory = [
      ...previousHistory,
      { role: 'user' as const, content: userMessage },
      { role: 'assistant' as const, content: assistantMessage },
    ].slice(-20);

    this.histories.set(chatId, updatedHistory);
    await this.persistHistories();
  }

  private async clearHistory(chatId: string): Promise<void> {
    const previousHistory = this.histories.get(chatId);
    this.histories.delete(chatId);

    try {
      await this.persistHistories();
    } catch (error) {
      if (previousHistory) this.histories.set(chatId, previousHistory);
      throw error;
    }
  }

  private async persistHistories(): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      const temporaryPath = `${this.historyPath}.tmp`;
      await writeFile(
        temporaryPath,
        JSON.stringify(Object.fromEntries(this.histories)),
        'utf8',
      );
      await rename(temporaryPath, this.historyPath);
    });

    this.writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );

    await operation;
  }

  private async continuarFlujo(
    reply: (message: string) => Promise<void>,
    chatId: string,
    texto: string,
    flow: ConversationFlow,
  ): Promise<void> {
    if (flow.step === 'product_search' || flow.step === 'quote_search') {
      await this.buscarProductos(
        reply,
        chatId,
        texto,
        flow.step === 'quote_search',
      );
      return;
    }

    if (flow.step === 'select_product') {
      const index = Number(texto);
      if (
        !Number.isInteger(index) ||
        index < 1 ||
        index > flow.products.length
      ) {
        await reply(
          `Responde con un número entre 1 y ${flow.products.length}, o escribe /cancelar.`,
        );
        return;
      }

      const product = flow.products[index - 1];
      if (!product) {
        await reply('No pude identificar ese producto. Inténtalo de nuevo.');
        return;
      }

      this.flows.set(chatId, { step: 'quantity', product });
      await reply(
        `Seleccionaste ${product.nombre}. ¿Cuántas unidades quieres cotizar?`,
      );
      return;
    }

    const quantity = Number(texto);
    if (!Number.isInteger(quantity) || quantity < 1) {
      await reply('Indica una cantidad entera positiva, o escribe /cancelar.');
      return;
    }

    this.flows.delete(chatId);
    const quote = await this.database.cotizarProducto(
      flow.product.id,
      quantity,
    );

    if (!quote.disponible) {
      const response =
        'mensaje' in quote && typeof quote.mensaje === 'string'
          ? quote.mensaje
          : 'No hay disponibilidad.';
      await this.rememberAndReply(reply, chatId, texto, response);
      return;
    }

    const product = quote.producto;
    const detail = quote.detalle;
    const total = Number(quote.subtotal);
    if (!product || !detail || !Number.isFinite(total)) {
      throw new Error('La base de datos devolvió una cotización incompleta.');
    }

    const currency = new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: 'COP',
      maximumFractionDigits: 0,
    });
    const details = detail
      .map(
        (item) =>
          `${item.unidades} × ${currency.format(Number(item.precioUnitario))} = ${currency.format(Number(item.subtotal))}`,
      )
      .join('\n');
    const response =
      `Cotización de ${product.nombre}\n` +
      `Cantidad: ${quote.cantidad}\n` +
      `${details}\n` +
      `Total: ${currency.format(total)}\n\n` +
      'Pedido pendiente por confirmar. La cotización no confirma ni reserva inventario; requiere aprobación de un asesor.';

    await this.rememberAndReply(reply, chatId, texto, response);
  }

  private async buscarProductos(
    reply: (message: string) => Promise<void>,
    chatId: string,
    busqueda: string,
    cotizar: boolean,
  ): Promise<void> {
    const rows = await this.database.consultarProductos(busqueda);
    const byId = new Map<number, CatalogProduct>();
    for (const row of rows) {
      const id = Number(row.id);
      if (!byId.has(id)) {
        byId.set(id, {
          id,
          nombre: String(row.nombre),
          marca: row.marca == null ? null : String(row.marca),
          categoria: row.categoria == null ? null : String(row.categoria),
        });
      }
    }

    const products = [...byId.values()].slice(0, 10);
    if (products.length === 0) {
      this.flows.delete(chatId);
      await reply(
        'No encontré productos con ese nombre. Prueba con otra palabra o escribe /cancelar.',
      );
      return;
    }

    if (!cotizar) {
      this.flows.delete(chatId);
      const response = products
        .map(
          (product, index) =>
            `${index + 1}. ${product.nombre}` +
            (product.marca ? ` — ${product.marca}` : '') +
            (product.categoria ? ` (${product.categoria})` : ''),
        )
        .join('\n');
      await reply(`Productos encontrados:\n${response}`);
      return;
    }

    this.flows.set(chatId, { step: 'select_product', products });
    const response = products
      .map(
        (product, index) =>
          `${index + 1}. ${product.nombre}` +
          (product.marca ? ` — ${product.marca}` : ''),
      )
      .join('\n');
    await reply(
      `Encontré estas opciones. Responde con el número del producto:\n${response}\n\nEscribe /cancelar para salir.`,
    );
  }

  private async rememberAndReply(
    reply: (message: string) => Promise<void>,
    chatId: string,
    userMessage: string,
    response: string,
  ): Promise<void> {
    await this.saveExchange(chatId, userMessage, response);
    await reply(response);
  }

  private async sendMessage(
    chatId: string,
    text: string,
    incomingKey: string,
  ): Promise<void> {
    const recipient = await this.resolveRecipient(chatId);
    const idempotencyKey = `reply-${createHmac('sha256', 'openwa-reply')
      .update(incomingKey)
      .digest('hex')
      .slice(0, 48)}`;
    const response = await fetch(
      `${this.openWaUrl.replace(/\/+$/, '')}/api/sessions/${encodeURIComponent(this.sessionId)}/messages/send-text`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.openWaApiKey,
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ chatId: recipient, text }),
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!response.ok) {
      throw new Error(
        `OpenWA rechazó el envío del mensaje (HTTP ${response.status}).`,
      );
    }
  }

  private async resolveRecipient(chatId: string): Promise<string> {
    if (!chatId.endsWith('@lid')) return chatId;

    const response = await fetch(
      `${this.openWaUrl.replace(/\/+$/, '')}/api/sessions/${encodeURIComponent(this.sessionId)}/contacts/${encodeURIComponent(chatId)}/phone`,
      {
        headers: { 'X-API-Key': this.openWaApiKey },
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!response.ok) {
      throw new Error(
        `OpenWA no pudo resolver el destinatario LID (HTTP ${response.status}).`,
      );
    }

    const result: unknown = await response.json();
    if (!result || typeof result !== 'object' || !('phone' in result)) {
      throw new Error(
        'OpenWA devolvió una respuesta inválida al resolver el destinatario LID.',
      );
    }

    if (result.phone === null) return chatId;
    if (typeof result.phone !== 'string' || !/^\d+$/.test(result.phone)) {
      throw new Error(
        'OpenWA devolvió un número telefónico inválido para el destinatario LID.',
      );
    }

    return `${result.phone}@c.us`;
  }

  private readonly mensajeAyuda =
    'Puedo ayudarte a buscar productos y preparar cotizaciones.\n\n' +
    '/productos [nombre] — buscar productos.\n' +
    '/cotizar — iniciar una cotización guiada.\n' +
    '/reset — borrar la memoria de esta conversación.\n' +
    '/cancelar — cancelar la búsqueda o cotización actual.\n' +
    '/ayuda — mostrar esta ayuda.\n\n' +
    'Las cotizaciones quedan pendientes de aprobación y no reservan inventario.';

  private esIntencionDePedido(texto: string): boolean {
    const normalizado = texto
      .toLocaleLowerCase('es')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    return [
      /\bquiero hacer (un )?pedido\b/,
      /\bquiero realizar (un )?pedido\b/,
      /\bquiero hacer (la )?compra\b/,
      /\bconfirmar (mi )?(pedido|compra)\b/,
      /\bquiero comprar\b/,
      /\bme llevo (el|la|los|las)?\s*\w+/,
    ].some((patron) => patron.test(normalizado));
  }
}
