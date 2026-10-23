import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot } from 'node-telegram-bot-api';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { AiService, type ConversationMessage } from '../ai/ai.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { Context } from 'node-telegram-bot-api';

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
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private readonly historyPath = resolve(
    process.cwd(),
    'data',
    'telegram-conversations.json',
  );
  private readonly histories = new Map<string, ConversationMessage[]>();
  private readonly flows = new Map<string, ConversationFlow>();
  private readonly chatQueues = new Map<string, Promise<void>>();
  private writeQueue: Promise<void> = Promise.resolve();
  private bot?: Bot;
  private polling?: Promise<void>;

  constructor(
    private readonly config: ConfigService,
    private readonly ai: AiService,
    private readonly database: DatabaseService,
  ) {}

  async onModuleInit() {
    await this.loadHistories();

    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');

    if (!token) {
      this.logger.error(
        'Falta TELEGRAM_BOT_TOKEN en el archivo .env. Telegram no se iniciará.',
      );
      return;
    }

    const bot = new Bot(token);
    this.bot = bot;

    bot.on('message', (context) => this.enqueueMessage(context));

    this.polling = bot.startPolling().catch((error: unknown) => {
      this.logger.error(
        'Error al recibir mensajes de Telegram.',
        error instanceof Error ? error.stack : undefined,
      );
    });

    this.logger.log('Bot de Telegram iniciado y esperando mensajes.');
  }

  async onModuleDestroy() {
    if (this.bot) {
      this.bot.stop();
      await this.polling;
      await this.writeQueue;
      this.bot = undefined;
      this.polling = undefined;
      this.logger.log('Bot de Telegram detenido.');
    }
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
        'El archivo de historial de Telegram tiene un formato inválido.',
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
      'Historiales de Telegram cargados desde el almacenamiento local.',
    );
  }

  private enqueueMessage(context: Context): void {
    const chatId = context.chatId;
    if (chatId === undefined) return;

    const key = String(chatId);
    const previous = this.chatQueues.get(key) ?? Promise.resolve();
    const current = previous
      .then(() => this.processMessage(context))
      .catch((error: unknown) => {
        this.logger.error(
          'Error inesperado procesando el mensaje de Telegram.',
          error instanceof Error ? error.stack : undefined,
        );
      });
    this.chatQueues.set(key, current);

    void current.then(() => {
      if (this.chatQueues.get(key) === current) {
        this.chatQueues.delete(key);
      }
    });
  }

  private async processMessage(context: Context): Promise<void> {
    const texto = context.message?.text?.trim();
    if (!texto) return;

    const chatId = String(context.chatId);

    try {
      const [command, ...commandArgs] = texto.split(/\s+/);
      const argument = commandArgs.join(' ').trim();

      if (command === '/start') {
        await context.reply(
          '¡Hola! Bienvenido a Distri Magik 💅\n\n' +
            'Puedo ayudarte a buscar productos y preparar cotizaciones.\n' +
            'Escribe /ayuda para ver las opciones.',
        );
        return;
      }

      if (command === '/help' || command === '/ayuda') {
        await context.reply(this.mensajeAyuda);
        return;
      }

      if (command === '/reset' || command === '/reiniciar') {
        this.flows.delete(chatId);
        await this.clearHistory(chatId);
        await context.reply('Listo, borré el contexto de esta conversación.');
        return;
      }

      if (command === '/cancelar') {
        this.flows.delete(chatId);
        await context.reply('Listo, cancelé el proceso actual.');
        return;
      }

      if (command === '/productos') {
        this.flows.set(chatId, { step: 'product_search' });
        if (argument) {
          await this.buscarProductos(context, chatId, argument, false);
        } else {
          await context.reply('¿Qué producto estás buscando?');
        }
        return;
      }

      if (command === '/cotizar') {
        this.flows.set(chatId, { step: 'quote_search' });
        if (argument) {
          await this.buscarProductos(context, chatId, argument, true);
        } else {
          await context.reply(
            '¿Qué producto y cantidad quieres cotizar? Primero dime el nombre del producto.',
          );
        }
        return;
      }

      const flow = this.flows.get(chatId);
      if (flow) {
        await this.continuarFlujo(context, chatId, texto, flow);
        return;
      }

      if (this.esIntencionDePedido(texto)) {
        this.flows.set(chatId, { step: 'quote_search' });
        await context.reply(
          'Con gusto te ayudo a preparar la cotización. ¿Qué producto deseas cotizar? Después te preguntaré la cantidad.',
        );
        return;
      }

      const historial = this.histories.get(chatId) ?? [];
      const resultado = await this.ai.responder(texto, historial);

      await this.saveExchange(chatId, texto, resultado.respuesta);
      await context.reply(resultado.respuesta);
    } catch (error) {
      this.logger.error(
        'No fue posible procesar el mensaje de Telegram.',
        error instanceof Error ? error.stack : undefined,
      );

      try {
        await context.reply(
          'En este momento no puedo procesar tu consulta. Inténtalo nuevamente en unos minutos.',
        );
      } catch (sendError) {
        this.logger.error(
          'No fue posible enviar el mensaje de error de Telegram.',
          sendError instanceof Error ? sendError.stack : undefined,
        );
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
    context: Context,
    chatId: string,
    texto: string,
    flow: ConversationFlow,
  ): Promise<void> {
    if (flow.step === 'product_search' || flow.step === 'quote_search') {
      await this.buscarProductos(
        context,
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
        await context.reply(
          `Responde con un número entre 1 y ${flow.products.length}, o escribe /cancelar.`,
        );
        return;
      }

      const product = flow.products[index - 1];
      if (!product) {
        await context.reply(
          'No pude identificar ese producto. Inténtalo de nuevo.',
        );
        return;
      }

      this.flows.set(chatId, { step: 'quantity', product });
      await context.reply(
        `Seleccionaste ${product.nombre}. ¿Cuántas unidades quieres cotizar?`,
      );
      return;
    }

    const quantity = Number(texto);
    if (!Number.isInteger(quantity) || quantity < 1) {
      await context.reply(
        'Indica una cantidad entera positiva, o escribe /cancelar.',
      );
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
      await this.rememberAndReply(context, chatId, texto, response);
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

    await this.rememberAndReply(context, chatId, texto, response);
  }

  private async buscarProductos(
    context: Context,
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
      await context.reply(
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
      await context.reply(`Productos encontrados:\n${response}`);
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
    await context.reply(
      `Encontré estas opciones. Responde con el número del producto:\n${response}\n\nEscribe /cancelar para salir.`,
    );
  }

  private async rememberAndReply(
    context: Context,
    chatId: string,
    userMessage: string,
    response: string,
  ): Promise<void> {
    await this.saveExchange(chatId, userMessage, response);
    await context.reply(response);
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
