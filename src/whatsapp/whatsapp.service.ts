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
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
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

type OrderItem = {
  product: CatalogProduct;
  quantity: number;
  subtotal: number;
};

type OrderDraft = {
  items: OrderItem[];
  customerName?: string;
  phone?: string;
  address?: string;
  cedula?: string;
};

type IncomingCartItem = {
  name: string;
  quantity: number;
};

type ReadyOrder = {
  id: string;
  chatId: string;
  customerName: string;
  phone: string;
  address: string;
  cedula?: string;
  items: OrderItem[];
  total: number;
  status:
    'delivery_pending' | 'ready_for_advisor' | 'approved' | 'changes_requested';
  createdAt: string;
  updatedAt: string;
};

function isReadyOrder(value: unknown): value is ReadyOrder {
  if (!value || typeof value !== 'object') return false;
  const order = value as Record<string, unknown>;
  return (
    typeof order.id === 'string' &&
    typeof order.chatId === 'string' &&
    typeof order.customerName === 'string' &&
    typeof order.phone === 'string' &&
    typeof order.address === 'string' &&
    typeof order.total === 'number' &&
    Number.isFinite(order.total) &&
    Array.isArray(order.items) &&
    order.items.every((item: unknown) => {
      if (!item || typeof item !== 'object') return false;
      const line = item as Record<string, unknown>;
      if (!line.product || typeof line.product !== 'object') return false;
      const product = line.product as Record<string, unknown>;
      return (
        typeof product.id === 'number' &&
        typeof product.nombre === 'string' &&
        Number.isInteger(line.quantity) &&
        typeof line.subtotal === 'number' &&
        Number.isFinite(line.subtotal)
      );
    }) &&
    [
      'delivery_pending',
      'ready_for_advisor',
      'approved',
      'changes_requested',
    ].includes(String(order.status)) &&
    typeof order.createdAt === 'string' &&
    typeof order.updatedAt === 'string'
  );
}

type ConversationFlow =
  | { step: 'product_search' }
  | { step: 'quote_search' }
  | { step: 'select_product'; products: CatalogProduct[] }
  | { step: 'quantity'; product: CatalogProduct }
  | { step: 'order_search' }
  | { step: 'order_cart_confirm' }
  | { step: 'order_select_product'; products: CatalogProduct[] }
  | { step: 'order_quantity'; product: CatalogProduct }
  | { step: 'order_add_more' }
  | { step: 'order_customer_name' }
  | { step: 'order_phone' }
  | { step: 'order_address' }
  | { step: 'order_cedula' }
  | { step: 'order_confirm' };

@Injectable()
export class WhatsAppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly historyPath = resolve(
    process.cwd(),
    'data',
    'whatsapp-conversations.json',
  );
  private readonly ordersPath: string;
  private readonly histories = new Map<string, ConversationMessage[]>();
  private readonly flows = new Map<string, ConversationFlow>();
  private readonly orderDrafts = new Map<string, OrderDraft>();
  private readonly orders = new Map<string, ReadyOrder>();
  private readonly chatQueues = new Map<string, Promise<void>>();
  private readonly inFlightEvents = new Map<string, Promise<void>>();
  private readonly processedEvents = new Set<string>();
  private writeQueue: Promise<void> = Promise.resolve();
  private orderWriteQueue: Promise<void> = Promise.resolve();
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
    this.ordersPath = resolve(
      this.config.get<string>(
        'WHATSAPP_ORDERS_FILE',
        resolve(process.cwd(), 'data', 'whatsapp-orders.json'),
      ),
    );
  }

  async onModuleInit() {
    await this.loadHistories();
    await this.loadOrders();

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
    await this.orderWriteQueue;
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

  private async loadOrders(): Promise<void> {
    let contents: string;
    try {
      contents = await readFile(this.ordersPath, 'utf8');
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
    if (!Array.isArray(parsed)) {
      throw new Error('El archivo de pedidos de WhatsApp no es válido.');
    }

    for (const order of parsed) {
      if (!isReadyOrder(order)) {
        throw new Error(
          'Un pedido almacenado de WhatsApp tiene datos inválidos.',
        );
      }
      this.orders.set(order.id, order);
    }
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

    let processEvent: Promise<void> | undefined;
    let messageWork: (() => Promise<void>) | undefined;
    if (payload.event === 'call.received') {
      processEvent = this.handleIncomingCall(data, eventKey);
    } else if (
      ['message.received', 'order.received'].includes(String(payload.event)) &&
      data.fromMe === false &&
      data.isGroup === false &&
      data.isStatusBroadcast !== true &&
      typeof data.chatId === 'string' &&
      this.extractCartItems(data)
    ) {
      messageWork = () =>
        this.enqueueCart(data.chatId as string, data, eventKey);
    } else if (
      payload.event === 'message.received' &&
      data.fromMe === false &&
      data.isGroup === false &&
      data.isStatusBroadcast !== true &&
      typeof data.chatId === 'string'
    ) {
      const chatId = data.chatId;
      const body = data.body;
      if (data.type === 'text' && typeof body === 'string' && body.trim()) {
        messageWork = () => this.enqueueMessage(chatId, body.trim(), eventKey);
      } else if (this.isVoiceMessageType(data.type)) {
        messageWork = () => this.enqueueVoiceMessage(data, eventKey);
      } else if (data.type === 'image') {
        messageWork = () => this.notifyAdvisorAboutImage(data, eventKey);
      } else {
        return { accepted: false };
      }
    } else {
      return { accepted: false };
    }

    if (messageWork) {
      const chatId = data.chatId as string;
      processEvent = this.markIncomingMessageAsRead(
        chatId,
        typeof data.id === 'string' ? data.id : undefined,
      )
        .catch((error: unknown) => {
          this.logger.warn(
            'No fue posible marcar como leído el mensaje entrante de WhatsApp.',
            error instanceof Error ? error.message : undefined,
          );
        })
        .then(messageWork);
    }

    if (!processEvent) return { accepted: false };

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

  private async markIncomingMessageAsRead(
    chatId: string,
    messageId: string | undefined,
  ): Promise<void> {
    const response = await fetch(
      `${this.openWaUrl.replace(/\/+$/, '')}/api/sessions/${encodeURIComponent(this.sessionId)}/chats/read`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.openWaApiKey,
        },
        body: JSON.stringify({
          chatId,
          ...(messageId ? { messageIds: [messageId] } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      throw new Error(
        `OpenWA rechazó la confirmación de lectura (HTTP ${response.status}).`,
      );
    }
  }

  private isVoiceMessageType(type: unknown): boolean {
    return type === 'audio' || type === 'ptt' || type === 'voice';
  }

  private extractCartItems(
    data: Record<string, unknown>,
  ): IncomingCartItem[] | undefined {
    const message = this.asRecord(data.message);
    const order = this.asRecord(data.order);
    const orderMessage = this.asRecord(
      data.orderMessage ?? message?.orderMessage ?? order?.orderMessage,
    );
    const arrays = [
      data.productItems,
      data.products,
      order?.productItems,
      order?.products,
      orderMessage?.productItems,
      orderMessage?.products,
    ];
    const rawItems = arrays.find(Array.isArray);
    if (!Array.isArray(rawItems)) return undefined;

    return rawItems.map((rawItem) => {
      const item = this.asRecord(rawItem);
      const product = this.asRecord(item?.product);
      const name = [
        item?.name,
        item?.productName,
        item?.product_name,
        item?.title,
        item?.productTitle,
        product?.name,
        product?.title,
      ]
        .find((value): value is string => typeof value === 'string')
        ?.trim();
      const quantity = item?.quantity ?? item?.qty;
      if (!name || !Number.isInteger(quantity) || Number(quantity) < 1) {
        return { name: '', quantity: 0 };
      }
      return { name, quantity: Number(quantity) };
    });
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private enqueueCart(
    chatId: string,
    data: Record<string, unknown>,
    eventKey: string,
  ): Promise<void> {
    const previous = this.chatQueues.get(chatId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() =>
        this.processIncomingCart(chatId, data, (message) =>
          this.sendMessage(chatId, message, `${eventKey}:cart`),
        ),
      )
      .catch((error: unknown) => {
        this.logger.error(
          'No fue posible procesar el carrito de WhatsApp.',
          error instanceof Error ? error.stack : undefined,
        );
        return this.sendMessage(
          chatId,
          'No pude verificar el carrito en el catálogo en este momento. No registré el pedido; inténtalo nuevamente o escribe /pedido para hacerlo manualmente.',
          `${eventKey}:cart-error`,
        ).catch((sendError: unknown) => {
          this.logger.error(
            'No fue posible notificar al cliente sobre el error de su carrito.',
            sendError instanceof Error ? sendError.stack : undefined,
          );
        });
      });
    this.chatQueues.set(chatId, current);
    return current.finally(() => {
      if (this.chatQueues.get(chatId) === current) {
        this.chatQueues.delete(chatId);
      }
    });
  }

  private async processIncomingCart(
    chatId: string,
    data: Record<string, unknown>,
    reply: (message: string) => Promise<void>,
  ): Promise<void> {
    const cart = this.extractCartItems(data);
    if (!cart?.length) {
      await reply(
        'Recibí un carrito vacío. Puedes enviar otro carrito o escribir /pedido para agregar productos manualmente.',
      );
      return;
    }
    if (
      cart.length > 20 ||
      cart.some((item) => !item.name || item.quantity < 1)
    ) {
      await reply(
        'No pude leer todos los productos y cantidades del carrito. No registraré el pedido; escribe /pedido para agregar los productos manualmente.',
      );
      return;
    }
    if (this.orderDrafts.has(chatId)) {
      await reply(
        'Ya hay un pedido en preparación en este chat. Termínalo o escribe /cancelar antes de enviar otro carrito.',
      );
      return;
    }

    const aggregated = new Map<string, IncomingCartItem>();
    for (const item of cart) {
      const key = this.normalizeProductName(item.name);
      const existing = aggregated.get(key);
      const quantity = (existing?.quantity ?? 0) + item.quantity;
      if (!key || quantity > 10000) {
        await reply(
          'La cantidad de un producto del carrito no es válida. No registraré el pedido; escribe /pedido para revisarlo manualmente.',
        );
        return;
      }
      aggregated.set(key, { name: item.name, quantity });
    }

    const matchedItems: OrderItem[] = [];
    const unmatched: string[] = [];
    for (const cartItem of aggregated.values()) {
      const rows = await this.database.consultarProductos(cartItem.name);
      const exactProducts = new Map<number, CatalogProduct>();
      for (const row of rows) {
        if (
          this.normalizeProductName(String(row.nombre)) !==
          this.normalizeProductName(cartItem.name)
        ) {
          continue;
        }
        const id = Number(row.id);
        exactProducts.set(id, {
          id,
          nombre: String(row.nombre),
          marca: row.marca == null ? null : String(row.marca),
          categoria: row.categoria == null ? null : String(row.categoria),
        });
      }
      if (exactProducts.size !== 1) {
        unmatched.push(cartItem.name);
        continue;
      }

      const product = [...exactProducts.values()][0];
      if (!product) {
        unmatched.push(cartItem.name);
        continue;
      }
      const quote = await this.database.cotizarProducto(
        product.id,
        cartItem.quantity,
      );
      const subtotal = Number(quote.subtotal);
      if (!quote.disponible || !Number.isFinite(subtotal) || subtotal < 0) {
        unmatched.push(`${cartItem.name} (${cartItem.quantity} unidades)`);
        continue;
      }
      matchedItems.push({ product, quantity: cartItem.quantity, subtotal });
    }

    if (unmatched.length > 0) {
      await reply(
        `No pude validar en el catálogo o cotizar estos productos: ${unmatched.join(', ')}. No registré el carrito. Escribe /pedido para revisarlos manualmente o contacta al asesor.`,
      );
      return;
    }

    const draft: OrderDraft = { items: matchedItems };
    const phone = this.normalizePhoneNumber(chatId);
    if (phone && phone.length >= 10 && phone.length <= 15) {
      draft.phone = phone;
    } else {
      const resolvedPhone = await this.resolvePhoneNumber(chatId);
      if (
        resolvedPhone &&
        resolvedPhone.length >= 10 &&
        resolvedPhone.length <= 15
      ) {
        draft.phone = resolvedPhone;
      }
    }

    this.orderDrafts.set(chatId, draft);
    this.flows.set(chatId, { step: 'order_cart_confirm' });
    await reply(
      `Recibí el carrito y validé sus productos con nuestro catálogo:\n\n${this.formatOrderDraft(draft)}\n\n¿Deseas continuar con este pedido? Esto todavía no lo confirma ni lo envía al asesor. Responde sí o no.`,
    );
  }

  private normalizeProductName(value: string): string {
    return value
      .toLocaleLowerCase('es')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  private async notifyAdvisorAboutImage(
    data: Record<string, unknown>,
    eventKey: string,
  ): Promise<void> {
    if (
      !this.advisorPhone ||
      typeof data.chatId !== 'string' ||
      typeof data.id !== 'string' ||
      !data.id
    ) {
      throw new BadRequestException(
        'No se pudo identificar la imagen o el teléfono del asesor.',
      );
    }

    const callerId = typeof data.from === 'string' ? data.from : data.chatId;
    let callerNumber: string | undefined;
    try {
      callerNumber = await this.resolvePhoneNumber(callerId);
    } catch (error) {
      this.logger.error(
        'No fue posible resolver el número del contacto que envió una imagen.',
        error instanceof Error ? error.stack : undefined,
      );
    }

    const advisorChat = `${this.advisorPhone}@c.us`;
    const sender = callerNumber ?? 'número no disponible';
    const mediaResponse = await fetch(
      `${this.openWaUrl.replace(/\/+$/, '')}/api/sessions/${encodeURIComponent(this.sessionId)}/messages/${encodeURIComponent(data.chatId)}/${encodeURIComponent(data.id)}/media`,
      {
        headers: { 'X-API-Key': this.openWaApiKey },
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!mediaResponse.ok) {
      await this.sendMessage(
        advisorChat,
        `Un cliente envió una imagen, pero OpenWA no pudo descargarla (HTTP ${mediaResponse.status}). Número: ${sender}. Revisa el chat en WhatsApp.`,
        `${eventKey}:image-unavailable`,
      );
      return;
    }

    const mimetype =
      mediaResponse.headers.get('content-type')?.split(';')[0] ??
      'application/octet-stream';
    if (!mimetype.startsWith('image/')) {
      await this.sendMessage(
        advisorChat,
        `Un cliente envió un archivo de imagen que OpenWA identificó como ${mimetype}. Número: ${sender}. Revisa el chat en WhatsApp.`,
        `${eventKey}:image-invalid`,
      );
      return;
    }

    const bytes = await mediaResponse.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > 10 * 1024 * 1024) {
      await this.sendMessage(
        advisorChat,
        `Un cliente envió una imagen${bytes.byteLength > 0 ? ' de más de 10 MB' : ''}. No se pudo reenviar; revisa el chat en WhatsApp. Número: ${sender}.`,
        `${eventKey}:image-size`,
      );
      return;
    }

    const imageKey = createHmac('sha256', 'openwa-image')
      .update(eventKey)
      .digest('hex')
      .slice(0, 48);
    const response = await fetch(
      `${this.openWaUrl.replace(/\/+$/, '')}/api/sessions/${encodeURIComponent(this.sessionId)}/messages/send-image`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.openWaApiKey,
          'Idempotency-Key': `image-${imageKey}`,
        },
        body: JSON.stringify({
          chatId: advisorChat,
          base64: Buffer.from(bytes).toString('base64'),
          mimetype,
          caption: `Imagen enviada por un cliente.\nNúmero: ${sender}`,
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!response.ok) {
      throw new Error(
        `OpenWA rechazó el reenvío de la imagen al asesor (HTTP ${response.status}).`,
      );
    }
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

    const callerId =
      typeof data.from === 'string'
        ? data.from
        : typeof data.chatId === 'string'
          ? data.chatId
          : undefined;
    let callerNumber: string | undefined;
    if (callerId) {
      try {
        callerNumber = await this.resolvePhoneNumber(callerId);
      } catch (error) {
        this.logger.error(
          'No fue posible resolver el número del contacto que llamó.',
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
    await this.sendMessage(
      `${this.advisorPhone}@c.us`,
      `${rejectionNotice}\nNúmero del contacto: ${callerNumber ?? 'No disponible; revisa el chat en OpenWA.'}\nRevisa el chat para responderle.`,
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
          '¡Hola! Bienvenido a LadyNail Shop 💅\n\n' +
            'Soy la asesora virtual y puedo ayudarte a buscar, cotizar y preparar pedidos.\n' +
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
        this.orderDrafts.delete(chatId);
        await this.clearHistory(chatId);
        await reply('Listo, borré el contexto de esta conversación.');
        return;
      }

      if (command === '/cancelar') {
        this.flows.delete(chatId);
        this.orderDrafts.delete(chatId);
        await reply('Listo, cancelé el proceso actual.');
        return;
      }

      if (command === '/pedido') {
        if (commandArgs[0] === 'aprobar' || commandArgs[0] === 'cambios') {
          await this.updateOrder(chatId, commandArgs[0], commandArgs[1], reply);
          return;
        }
        if (commandArgs[0] === 'reintentar') {
          await this.retryOrderDelivery(chatId, commandArgs[1], reply);
          return;
        }
        if (commandArgs[0] === 'estado') {
          await this.reportOrderStatus(chatId, commandArgs[1], reply);
          return;
        }
        await this.startOrder(reply, chatId);
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
        if (flow.step.startsWith('order_')) {
          await this.continuarPedido(reply, chatId, texto, flow);
          return;
        }
        await this.continuarFlujo(reply, chatId, texto, flow);
        return;
      }

      if (this.esIntencionDePedido(texto)) {
        await this.startOrder(reply, chatId);
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

    if (flow.step !== 'quantity') {
      throw new Error(`Paso de conversación no soportado: ${flow.step}`);
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

  private async startOrder(
    reply: (message: string) => Promise<void>,
    chatId: string,
  ): Promise<void> {
    this.orderDrafts.set(chatId, { items: [] });
    this.flows.set(chatId, { step: 'order_search' });
    await reply(
      'Vamos a preparar tu pedido. Dime el nombre del primer producto que deseas agregar.',
    );
  }

  private async continuarPedido(
    reply: (message: string) => Promise<void>,
    chatId: string,
    texto: string,
    flow: ConversationFlow,
  ): Promise<void> {
    const draft = this.orderDrafts.get(chatId);
    if (!draft) {
      await this.startOrder(reply, chatId);
      return;
    }

    if (flow.step === 'order_cart_confirm') {
      const answer = this.normalizeAnswer(texto);
      if (['no', 'n'].includes(answer)) {
        this.orderDrafts.delete(chatId);
        this.flows.delete(chatId);
        await reply(
          'De acuerdo, no continuaré con el carrito. Si quieres prepararlo más tarde, escribe /pedido.',
        );
        return;
      }
      if (!['si', 'sí', 's', 'confirmo', 'confirmar'].includes(answer)) {
        await reply(
          'Responde sí para continuar con los productos del carrito o no para descartarlo.',
        );
        return;
      }

      if (draft.phone) {
        this.flows.set(chatId, { step: 'order_customer_name' });
        await reply('¿A nombre de quién registramos el pedido?');
      } else {
        this.flows.set(chatId, { step: 'order_phone' });
        await reply(
          'No pude verificar el número de WhatsApp. Escríbelo con código de país, por ejemplo 573001234567.',
        );
      }
      return;
    }

    if (flow.step === 'order_search') {
      const rows = await this.database.consultarProductos(texto);
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
        await reply(
          'No encontré ese producto en el catálogo. Prueba con otro nombre.',
        );
        return;
      }

      this.flows.set(chatId, { step: 'order_select_product', products });
      await reply(
        `Elige el producto escribiendo su número:\n${products
          .map(
            (product, index) =>
              `${index + 1}. ${product.nombre}` +
              (product.marca ? ` — ${product.marca}` : ''),
          )
          .join('\n')}`,
      );
      return;
    }

    if (flow.step === 'order_select_product') {
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
      this.flows.set(chatId, { step: 'order_quantity', product });
      await reply(`¿Cuántas unidades de ${product.nombre} deseas?`);
      return;
    }

    if (flow.step === 'order_quantity') {
      const quantity = Number(texto);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) {
        await reply('Indica una cantidad entera entre 1 y 10.000.');
        return;
      }

      const quote = await this.database.cotizarProducto(
        flow.product.id,
        quantity,
      );
      if (!quote.disponible) {
        const response =
          'mensaje' in quote && typeof quote.mensaje === 'string'
            ? quote.mensaje
            : 'No hay disponibilidad para esa cantidad.';
        await reply(response);
        return;
      }
      const subtotal = Number(quote.subtotal);
      const product = quote.producto;
      if (!product || !Number.isFinite(subtotal) || subtotal < 0) {
        throw new Error(
          'La base de datos devolvió una cotización incompleta para el pedido.',
        );
      }

      draft.items.push({
        product: flow.product,
        quantity,
        subtotal,
      });
      this.flows.set(chatId, { step: 'order_add_more' });
      await reply(
        `Agregué ${quantity} × ${flow.product.nombre} por ${this.formatCurrency(subtotal)}.\n` +
          '¿Quieres agregar otro producto? Responde sí o no.',
      );
      return;
    }

    if (flow.step === 'order_add_more') {
      const answer = this.normalizeAnswer(texto);
      if (['si', 'sí', 's'].includes(answer)) {
        this.flows.set(chatId, { step: 'order_search' });
        await reply('¿Qué producto deseas agregar?');
        return;
      }
      if (!['no', 'n'].includes(answer)) {
        await reply(
          'Responde sí para agregar otro producto o no para continuar.',
        );
        return;
      }

      const phone = await this.resolvePhoneNumber(chatId);
      if (phone && phone.length >= 10 && phone.length <= 15) {
        draft.phone = phone;
      }
      this.flows.set(
        chatId,
        draft.phone ? { step: 'order_customer_name' } : { step: 'order_phone' },
      );
      await reply(
        draft.phone
          ? '¿A nombre de quién registramos el pedido?'
          : 'No pude verificar el número de WhatsApp. Escríbelo con código de país, por ejemplo 573001234567.',
      );
      return;
    }

    if (flow.step === 'order_phone') {
      const phone = this.normalizePhoneNumber(texto);
      if (!phone || phone.length < 10 || phone.length > 15) {
        await reply(
          'Escribe un número válido con código de país, solo dígitos (entre 10 y 15), o /cancelar.',
        );
        return;
      }
      draft.phone = phone;
      this.flows.set(chatId, { step: 'order_customer_name' });
      await reply('¿A nombre de quién registramos el pedido?');
      return;
    }

    if (flow.step === 'order_customer_name') {
      const name = texto.trim();
      if (name.length < 2 || name.length > 100) {
        await reply('Escribe un nombre válido (entre 2 y 100 caracteres).');
        return;
      }
      draft.customerName = name;
      this.flows.set(chatId, { step: 'order_address' });
      await reply('¿Cuál es la dirección de entrega?');
      return;
    }

    if (flow.step === 'order_address') {
      const address = texto.trim();
      if (address.length < 5 || address.length > 250) {
        await reply('Escribe una dirección válida (entre 5 y 250 caracteres).');
        return;
      }
      draft.address = address;
      this.flows.set(chatId, { step: 'order_cedula' });
      await reply(
        '¿Deseas incluir tu cédula? Es opcional; envíala o responde «no».',
      );
      return;
    }

    if (flow.step === 'order_cedula') {
      const answer = this.normalizeAnswer(texto);
      if (!['no', 'n', 'omitir', 'pasar'].includes(answer)) {
        const cedula = texto.replace(/\D/g, '');
        if (cedula.length < 5 || cedula.length > 15) {
          await reply(
            'La cédula debe tener entre 5 y 15 dígitos, o responde «no» para omitirla.',
          );
          return;
        }
        draft.cedula = cedula;
      }
      this.flows.set(chatId, { step: 'order_confirm' });
      await reply(
        `${this.formatOrderDraft(draft)}\n\n¿Confirmas que envíe este pedido al asesor? Responde sí o no.`,
      );
      return;
    }

    if (flow.step === 'order_confirm') {
      const answer = this.normalizeAnswer(texto);
      if (['no', 'n'].includes(answer)) {
        this.orderDrafts.delete(chatId);
        this.flows.delete(chatId);
        await reply(
          'Pedido cancelado. Si deseas iniciar otro, escribe /pedido.',
        );
        return;
      }
      if (!['si', 'sí', 'confirmo', 'confirmar', 's'].includes(answer)) {
        await reply(
          'Responde sí para confirmar el envío al asesor o no para cancelar.',
        );
        return;
      }
      if (
        !draft.customerName ||
        !draft.phone ||
        !draft.address ||
        draft.items.length === 0
      ) {
        throw new Error('El borrador del pedido está incompleto.');
      }

      const updatedItems: OrderItem[] = [];
      for (const item of draft.items) {
        const quote = await this.database.cotizarProducto(
          item.product.id,
          item.quantity,
        );
        if (!quote.disponible) {
          await reply(
            `No puedo confirmar ${item.product.nombre} para esa cantidad porque ya no aparece disponible. Escribe /cancelar para detener el pedido.`,
          );
          return;
        }
        const subtotal = Number(quote.subtotal);
        if (!Number.isFinite(subtotal) || subtotal < 0) {
          throw new Error('La base de datos devolvió un total inválido.');
        }
        updatedItems.push({ ...item, subtotal });
      }

      const changed = updatedItems.some(
        (item, index) => item.subtotal !== draft.items[index]?.subtotal,
      );
      draft.items = updatedItems;
      if (changed) {
        await reply(
          `El precio cambió desde la cotización inicial. Revisa el total actualizado:\n\n${this.formatOrderDraft(draft)}\n\nResponde sí para confirmar este nuevo total o no para cancelar.`,
        );
        return;
      }

      const now = new Date().toISOString();
      if (!this.advisorPhone) {
        throw new Error(
          'No se puede entregar el pedido: OPENWA_ADVISOR_PHONE no está configurado.',
        );
      }
      const order: ReadyOrder = {
        id: randomUUID().slice(0, 8).toUpperCase(),
        chatId,
        customerName: draft.customerName ?? '',
        phone: draft.phone ?? '',
        address: draft.address ?? '',
        ...(draft.cedula ? { cedula: draft.cedula } : {}),
        items: draft.items,
        total: draft.items.reduce((sum, item) => sum + item.subtotal, 0),
        status: 'delivery_pending',
        createdAt: now,
        updatedAt: now,
      };

      this.orders.set(order.id, order);
      try {
        await this.persistOrders();
      } catch (error) {
        this.orders.delete(order.id);
        throw error;
      }
      try {
        await this.sendAdvisorOrder(order);
        order.status = 'ready_for_advisor';
        const previousUpdatedAt = order.updatedAt;
        order.updatedAt = new Date().toISOString();
        try {
          await this.persistOrders();
        } catch (error) {
          order.status = 'delivery_pending';
          order.updatedAt = previousUpdatedAt;
          throw error;
        }
      } catch (error) {
        this.logger.error(
          `El pedido ${order.id} quedó guardado, pero falta completar su entrega al asesor.`,
          error instanceof Error ? error.stack : undefined,
        );
        this.orderDrafts.delete(chatId);
        this.flows.delete(chatId);
        await reply(
          `Guardé tu pedido con el código ${order.id}, pero no pude confirmar su entrega al asesor. Escribe «/pedido reintentar ${order.id}» para volver a enviarlo. No está confirmado.`,
        );
        return;
      }
      this.orderDrafts.delete(chatId);
      this.flows.delete(chatId);
      await reply(
        `Tu solicitud quedó registrada con el código ${order.id} y fue enviada al asesor. El pedido no está confirmado hasta que el asesor lo apruebe.`,
      );
      return;
    }

    throw new Error(`Paso de pedido no soportado: ${flow.step}`);
  }

  private async persistOrders(): Promise<void> {
    const operation = this.orderWriteQueue.then(async () => {
      await mkdir(dirname(this.ordersPath), { recursive: true });
      const temporaryPath = `${this.ordersPath}.tmp`;
      await writeFile(
        temporaryPath,
        JSON.stringify([...this.orders.values()], null, 2),
        'utf8',
      );
      await rename(temporaryPath, this.ordersPath);
    });
    this.orderWriteQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }

  private async sendAdvisorOrder(order: ReadyOrder): Promise<void> {
    const message =
      `PEDIDO ${order.id} — PENDIENTE DE APROBACIÓN\n` +
      `Cliente: ${order.customerName}\n` +
      `Celular: ${order.phone}\n` +
      `Dirección: ${order.address}\n` +
      (order.cedula ? `Cédula: ${order.cedula}\n` : '') +
      `Productos:\n${order.items.map((item) => `• ${item.quantity} × ${item.product.nombre} — ${this.formatCurrency(item.subtotal)}`).join('\n')}\n` +
      `Total cotizado: ${this.formatCurrency(order.total)}\n\n` +
      `Aprueba con: /pedido aprobar ${order.id}\n` +
      `Solicita cambios con: /pedido cambios ${order.id}`;
    await this.sendMessage(
      `${this.advisorPhone}@c.us`,
      message,
      `order-${order.id}`,
    );
  }

  private async updateOrder(
    chatId: string,
    action: string,
    orderId: string | undefined,
    reply: (message: string) => Promise<void>,
  ): Promise<void> {
    const phone = await this.resolvePhoneNumber(chatId);
    if (phone !== this.advisorPhone) {
      await reply('Este comando solo está disponible para el asesor.');
      return;
    }
    const order = orderId ? this.orders.get(orderId.toUpperCase()) : undefined;
    if (!order) {
      await reply('No encontré ese pedido. Verifica el código indicado.');
      return;
    }
    if (order.status !== 'ready_for_advisor') {
      await reply(`El pedido ${order.id} ya fue gestionado (${order.status}).`);
      return;
    }

    const previousStatus = order.status;
    const previousUpdatedAt = order.updatedAt;
    order.status = action === 'aprobar' ? 'approved' : 'changes_requested';
    order.updatedAt = new Date().toISOString();
    try {
      await this.persistOrders();
    } catch (error) {
      order.status = previousStatus;
      order.updatedAt = previousUpdatedAt;
      throw error;
    }
    await this.sendMessage(
      order.chatId,
      action === 'aprobar'
        ? `El asesor aprobó tu pedido ${order.id}. Se pondrá en contacto contigo para coordinar los siguientes pasos.`
        : `El asesor revisó tu pedido ${order.id} y necesita algunos cambios. Se pondrá en contacto contigo.`,
      `order-${order.id}-${action}`,
    );
    await reply(
      `Pedido ${order.id}: ${action === 'aprobar' ? 'aprobado' : 'marcado para cambios'}.`,
    );
  }

  private async retryOrderDelivery(
    chatId: string,
    orderId: string | undefined,
    reply: (message: string) => Promise<void>,
  ): Promise<void> {
    const order = orderId ? this.orders.get(orderId.toUpperCase()) : undefined;
    if (!order || order.chatId !== chatId) {
      await reply('No encontré ese pedido para este número de WhatsApp.');
      return;
    }
    if (order.status !== 'delivery_pending') {
      await reply(`El pedido ${order.id} no tiene una entrega pendiente.`);
      return;
    }
    await this.sendAdvisorOrder(order);
    order.status = 'ready_for_advisor';
    const previousUpdatedAt = order.updatedAt;
    order.updatedAt = new Date().toISOString();
    try {
      await this.persistOrders();
    } catch (error) {
      order.status = 'delivery_pending';
      order.updatedAt = previousUpdatedAt;
      throw error;
    }
    await reply(
      `El pedido ${order.id} fue enviado al asesor y sigue pendiente de aprobación.`,
    );
  }

  private async reportOrderStatus(
    chatId: string,
    orderId: string | undefined,
    reply: (message: string) => Promise<void>,
  ): Promise<void> {
    const order = orderId ? this.orders.get(orderId.toUpperCase()) : undefined;
    if (!order) {
      await reply('No encontré ese pedido. Verifica el código indicado.');
      return;
    }

    if (order.chatId !== chatId) {
      const phone = await this.resolvePhoneNumber(chatId);
      if (!this.advisorPhone || phone !== this.advisorPhone) {
        await reply('No tienes acceso al estado de ese pedido.');
        return;
      }
    }

    const statuses: Record<ReadyOrder['status'], string> = {
      delivery_pending: 'pendiente de entrega al asesor',
      ready_for_advisor: 'pendiente de aprobación del asesor',
      approved: 'aprobado por el asesor',
      changes_requested: 'requiere cambios; el asesor se pondrá en contacto',
    };
    await reply(`El pedido ${order.id} está ${statuses[order.status]}.`);
  }

  private formatOrderDraft(draft: OrderDraft): string {
    const total = draft.items.reduce((sum, item) => sum + item.subtotal, 0);
    return (
      'RESUMEN DEL PEDIDO\n' +
      `Cliente: ${draft.customerName ?? '—'}\n` +
      `Celular: ${draft.phone ?? '—'}\n` +
      `Dirección: ${draft.address ?? '—'}\n` +
      (draft.cedula ? `Cédula: ${draft.cedula}\n` : '') +
      `Productos:\n${draft.items.map((item) => `• ${item.quantity} × ${item.product.nombre} — ${this.formatCurrency(item.subtotal)}`).join('\n')}\n` +
      `Total cotizado: ${this.formatCurrency(total)}`
    );
  }

  private formatCurrency(amount: number): string {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: 'COP',
      maximumFractionDigits: 0,
    }).format(amount);
  }

  private normalizeAnswer(value: string): string {
    return value
      .trim()
      .toLocaleLowerCase('es')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
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

    const phone = await this.resolvePhoneNumber(chatId);
    return phone ? `${phone}@c.us` : chatId;
  }

  private async resolvePhoneNumber(
    contactId: string,
  ): Promise<string | undefined> {
    if (contactId.endsWith('@c.us')) {
      return this.normalizePhoneNumber(contactId);
    }

    const response = await fetch(
      `${this.openWaUrl.replace(/\/+$/, '')}/api/sessions/${encodeURIComponent(this.sessionId)}/contacts/${encodeURIComponent(contactId)}/phone`,
      {
        headers: { 'X-API-Key': this.openWaApiKey },
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (response.ok) {
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || !('phone' in result)) {
        throw new Error(
          'OpenWA devolvió una respuesta inválida al resolver el destinatario LID.',
        );
      }

      const phone = this.normalizePhoneNumber(result.phone);
      if (phone) return phone;
    } else if (response.status !== 404) {
      throw new Error(
        `OpenWA no pudo resolver el destinatario LID (HTTP ${response.status}).`,
      );
    }

    const contactResponse = await fetch(
      `${this.openWaUrl.replace(/\/+$/, '')}/api/sessions/${encodeURIComponent(this.sessionId)}/contacts/${encodeURIComponent(contactId)}`,
      {
        headers: { 'X-API-Key': this.openWaApiKey },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (contactResponse.status === 404) return undefined;
    if (!contactResponse.ok) {
      throw new Error(
        `OpenWA no pudo consultar los datos del contacto (HTTP ${contactResponse.status}).`,
      );
    }

    const contact: unknown = await contactResponse.json();
    if (!contact || typeof contact !== 'object' || !('number' in contact)) {
      throw new Error('OpenWA devolvió datos de contacto inválidos.');
    }

    return this.normalizePhoneNumber(contact.number);
  }

  private normalizePhoneNumber(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const phone = value.split('@')[0]?.replace(/\D/g, '');
    return phone && phone.length >= 7 ? phone : undefined;
  }

  private readonly mensajeAyuda =
    'Soy tu asesora comercial de LadyNail Shop. Puedo ayudarte a buscar productos, cotizar y preparar pedidos para revisión del asesor.\n\n' +
    '/productos [nombre] — buscar productos.\n' +
    '/cotizar — iniciar una cotización guiada.\n' +
    '/pedido — preparar un pedido con datos y confirmación. También puedes enviar un carrito de WhatsApp Business.\n' +
    '/reset — borrar la memoria de esta conversación.\n' +
    '/cancelar — cancelar el flujo actual.\n' +
    '/pedido aprobar [código] — aprobar un pedido (solo asesor).\n' +
    '/pedido cambios [código] — solicitar cambios (solo asesor).\n' +
    '/pedido reintentar [código] — reintentar la entrega pendiente al asesor.\n' +
    '/pedido estado [código] — consultar el estado del pedido.\n' +
    '/ayuda — mostrar esta ayuda.\n\n' +
    'Los pedidos quedan pendientes de aprobación y no reservan inventario.';

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
