import { Test } from '@nestjs/testing';
import { createHmac, randomUUID } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, vi } from 'vitest';
import { AiService } from '../ai/ai.service.js';
import { DatabaseService } from '../database/database.service.js';
import { WhatsAppService } from './whatsapp.service.js';

describe('WhatsAppService', () => {
  const secret = 'test-webhook-secret';
  const ordersPath = join(tmpdir(), `whatsapp-orders-${randomUUID()}.json`);
  let service: WhatsAppService;
  let config: Record<string, string>;

  beforeEach(async () => {
    config = {
      OPENWA_API_KEY: 'test-api-key',
      OPENWA_SESSION_ID: 'test-session',
      OPENWA_WEBHOOK_SECRET: secret,
      OPENWA_ADVISOR_PHONE: '573001112233',
      WHATSAPP_ORDERS_FILE: ordersPath,
    };
    const module = await Test.createTestingModule({
      providers: [
        WhatsAppService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, defaultValue?: string) =>
              config[key] ?? defaultValue,
          },
        },
        { provide: AiService, useValue: {} },
        { provide: DatabaseService, useValue: {} },
      ],
    }).compile();

    service = module.get(WhatsAppService);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(ordersPath, { force: true });
    await rm(`${ordersPath}.tmp`, { force: true });
  });

  function sign(body: Buffer): string {
    return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  }

  it('rejects webhooks with an invalid signature', async () => {
    const body = Buffer.from('{}');

    await expect(
      service.handleIncomingEvent({}, body, 'sha256=' + '0'.repeat(64)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('ignores messages sent by the WhatsApp session', async () => {
    const event = {
      event: 'message.received',
      sessionId: 'test-session',
      idempotencyKey: 'event-1',
      data: {
        chatId: '123456789@c.us',
        body: 'Hola',
        type: 'text',
        fromMe: true,
        isGroup: false,
        isStatusBroadcast: false,
      },
    };
    const body = Buffer.from(JSON.stringify(event));

    await expect(
      service.handleIncomingEvent(event, body, sign(body)),
    ).resolves.toEqual({ accepted: false });
  });

  it('acknowledges the webhook without waiting for the WhatsApp send', async () => {
    let finishSend!: (response: Response) => void;
    const sendResponse = new Promise<Response>((resolve) => {
      finishSend = resolve;
    });
    const fetchMock = vi.fn(
      (input: string | Request | URL, _init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        return url.endsWith('/chats/read')
          ? Promise.resolve(new Response('{}', { status: 201 }))
          : sendResponse;
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const event = {
      event: 'message.received',
      sessionId: 'test-session',
      idempotencyKey: 'event-2',
      data: {
        id: 'help-message-2',
        chatId: '123456789@c.us',
        body: '/ayuda',
        type: 'text',
        fromMe: false,
        isGroup: false,
        isStatusBroadcast: false,
      },
    };
    const body = Buffer.from(JSON.stringify(event));

    await expect(
      service.handleIncomingEvent(event, body, sign(body)),
    ).resolves.toEqual({ accepted: true });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const readRequest = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith('/chats/read'),
    );
    expect(readRequest?.[1]?.method).toBe('POST');
    expect(readRequest?.[1]?.body).toBe(
      JSON.stringify({
        chatId: '123456789@c.us',
        messageIds: ['help-message-2'],
      }),
    );
    finishSend(new Response('{}', { status: 201 }));
    await vi.waitFor(() =>
      expect(
        Promise.all(fetchMock.mock.results.map((result) => result.value)),
      ).resolves.toBeDefined(),
    );
  });

  it('uses the incoming LID if OpenWA has no phone mapping', async () => {
    const fetchMock = vi.fn(
      async (input: string | Request | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url.endsWith('/chats/read')) {
          return new Response('{}', { status: 201 });
        }
        if (url.endsWith('/phone')) {
          return Response.json({ phone: null });
        }
        if (url.includes('/contacts/')) {
          return Response.json({ number: '123456789@c.us' });
        }

        if (typeof init?.body !== 'string') {
          throw new Error('Expected a JSON request body.');
        }
        const request = JSON.parse(init.body) as { chatId: string };
        expect(request.chatId).toBe('123456789@c.us');
        return new Response('{}', { status: 201 });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const event = {
      event: 'message.received',
      sessionId: 'test-session',
      idempotencyKey: 'event-3',
      data: {
        chatId: '123456789@lid',
        body: '/ayuda',
        type: 'text',
        fromMe: false,
        isGroup: false,
        isStatusBroadcast: false,
      },
    };
    const body = Buffer.from(JSON.stringify(event));

    await expect(
      service.handleIncomingEvent(event, body, sign(body)),
    ).resolves.toEqual({ accepted: true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
  });

  it('rejects incoming calls and notifies the configured advisor', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 404 }))
      .mockResolvedValueOnce(Response.json({ phone: null }))
      .mockResolvedValueOnce(Response.json({ number: '123456789@c.us' }))
      .mockResolvedValueOnce(new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const event = {
      event: 'call.received',
      sessionId: 'test-session',
      idempotencyKey: 'call-1',
      data: {
        callId: 'incoming-call-1',
        from: '12345678901234@lid',
      },
    };
    const body = Buffer.from(JSON.stringify(event));

    await expect(
      service.handleIncomingEvent(event, body, sign(body)),
    ).resolves.toEqual({ accepted: true });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      '/calls/incoming-call-1/reject',
    );
    expect(fetchMock.mock.calls[3]?.[0]).toContain('/messages/send-text');
    const requestBody = fetchMock.mock.calls[3]?.[1]?.body;
    expect(typeof requestBody).toBe('string');
    expect(requestBody).toContain('Número del contacto: 123456789');
  });

  it('alerts the advisor if the OpenWA engine cannot reject a call', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 501 }))
      .mockResolvedValueOnce(new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const event = {
      event: 'call.received',
      sessionId: 'test-session',
      idempotencyKey: 'call-2',
      data: { callId: 'incoming-call-2', from: '123456789@c.us' },
    };
    const body = Buffer.from(JSON.stringify(event));

    await expect(
      service.handleIncomingEvent(event, body, sign(body)),
    ).resolves.toEqual({ accepted: true });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const requestBody = fetchMock.mock.calls[1]?.[1]?.body;
    expect(typeof requestBody).toBe('string');
    expect(requestBody).toContain(
      'OpenWA no pudo rechazar la llamada con el motor actual',
    );
  });

  it('transcribes incoming voice notes and processes their text', async () => {
    const fetchMock = vi.fn(
      async (input: string | Request | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url.endsWith('/chats/read')) {
          return new Response('{}', { status: 201 });
        }
        if (url.includes('/media')) {
          return new Response(new Uint8Array([1, 2, 3]), {
            headers: { 'Content-Type': 'audio/ogg' },
          });
        }
        if (url.endsWith('/audio/transcriptions')) {
          expect(init?.body).toBeInstanceOf(FormData);
          return Response.json({ text: '/ayuda' });
        }
        return new Response('{}', { status: 201 });
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    const event = {
      event: 'message.received',
      sessionId: 'test-session',
      idempotencyKey: 'voice-1',
      data: {
        id: 'voice-message-1',
        chatId: '123456789@c.us',
        body: '',
        type: 'ptt',
        fromMe: false,
        isGroup: false,
      },
    };
    const body = Buffer.from(JSON.stringify(event));

    await expect(
      service.handleIncomingEvent(event, body, sign(body)),
    ).resolves.toEqual({ accepted: true });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(
      fetchMock.mock.calls.find(([url]) =>
        String(url).endsWith('/audio/transcriptions'),
      )?.[0],
    ).toBe('http://localhost:8000/v1/audio/transcriptions');
  });

  it('forwards incoming images to the advisor with the sender phone number', async () => {
    const fetchMock = vi.fn(
      async (input: string | Request | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url.endsWith('/chats/read')) {
          return new Response('{}', { status: 201 });
        }
        if (url.endsWith('/phone')) {
          return Response.json({ phone: null });
        }
        if (url.endsWith('/contacts/12345678901234%40lid')) {
          return Response.json({ number: '573009998877@c.us' });
        }
        if (url.endsWith('/media')) {
          return new Response(new Uint8Array([1, 2, 3]), {
            headers: { 'Content-Type': 'image/jpeg' },
          });
        }
        if (url.endsWith('/messages/send-image')) {
          expect(typeof init?.body).toBe('string');
          const body = JSON.parse(init?.body as string) as {
            chatId: string;
            base64: string;
            mimetype: string;
            caption: string;
          };
          expect(body.chatId).toBe('573001112233@c.us');
          expect(body.base64).toBe('AQID');
          expect(body.mimetype).toBe('image/jpeg');
          expect(body.caption).toContain('573009998877');
          return new Response('{}', { status: 201 });
        }
        throw new Error(`Unexpected OpenWA request: ${url}`);
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    const event = {
      event: 'message.received',
      sessionId: 'test-session',
      idempotencyKey: 'image-1',
      data: {
        id: 'image-message-1',
        from: '12345678901234@lid',
        chatId: '12345678901234@lid',
        body: '',
        type: 'image',
        fromMe: false,
        isGroup: false,
      },
    };
    const body = Buffer.from(JSON.stringify(event));

    await expect(
      service.handleIncomingEvent(event, body, sign(body)),
    ).resolves.toEqual({ accepted: true });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
  });

  it('collects and confirms a complete order before handing it to the advisor', async () => {
    const product = {
      id: 12,
      nombre: 'Esmalte rojo',
      marca: 'Marca',
      categoria: 'Uñas',
    };
    const database = {
      consultarProductos: vi.fn().mockResolvedValue([product]),
      cotizarProducto: vi
        .fn()
        .mockImplementation(async (id: number, quantity: number) => ({
          disponible: true,
          producto: { ...product, id },
          cantidad: quantity,
          subtotal: quantity * 10000,
        })),
    };
    const module = await Test.createTestingModule({
      providers: [
        WhatsAppService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, defaultValue?: string) =>
              config[key] ?? defaultValue,
          },
        },
        { provide: AiService, useValue: {} },
        { provide: DatabaseService, useValue: database },
      ],
    }).compile();
    service = module.get(WhatsAppService);

    const sentMessages: Array<{ chatId: string; text: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | Request | URL, init?: RequestInit) => {
        if (typeof init?.body !== 'string') {
          throw new Error('Expected a JSON request body.');
        }
        if (String(_input).endsWith('/chats/read')) {
          return new Response('{}', { status: 201 });
        }
        const body = JSON.parse(init.body) as {
          chatId: string;
          text: string;
        };
        sentMessages.push(body);
        return new Response('{}', { status: 201 });
      }),
    );

    const sendText = async (
      id: string,
      text: string,
      expectedSends: number,
      chatId = '573009998877@c.us',
    ) => {
      const event = {
        event: 'message.received',
        sessionId: 'test-session',
        idempotencyKey: id,
        data: {
          id,
          chatId,
          body: text,
          type: 'text',
          fromMe: false,
          isGroup: false,
          isStatusBroadcast: false,
        },
      };
      const body = Buffer.from(JSON.stringify(event));
      await expect(
        service.handleIncomingEvent(event, body, sign(body)),
      ).resolves.toEqual({ accepted: true });
      await vi.waitFor(() => expect(sentMessages).toHaveLength(expectedSends));
    };

    await sendText('order-1', '/pedido', 1);
    await sendText('order-2', 'esmalte rojo', 2);
    await sendText('order-3', '1', 3);
    await sendText('order-4', '2', 4);
    await sendText('order-5', 'no', 5);
    await sendText('order-6', 'Ana Pérez', 6);
    await sendText('order-7', 'Calle 10 # 2-30, Bogotá', 7);
    await sendText('order-8', 'no', 8);
    await sendText('order-9', 'sí', 10);

    const savedOrders = JSON.parse(
      await readFile(ordersPath, 'utf8'),
    ) as Array<{
      customerName: string;
      phone: string;
      address: string;
      total: number;
      status: string;
    }>;
    expect(savedOrders).toHaveLength(1);
    expect(savedOrders[0]).toMatchObject({
      customerName: 'Ana Pérez',
      phone: '573009998877',
      address: 'Calle 10 # 2-30, Bogotá',
      total: 20000,
      status: 'ready_for_advisor',
    });
    expect(sentMessages[8]?.chatId).toBe('573001112233@c.us');
    expect(sentMessages[8]?.text).toContain('Ana Pérez');
    expect(sentMessages[8]?.text).toContain('573009998877');
    expect(sentMessages[8]?.text).toContain('20.000');
    expect(sentMessages[9]?.text).toContain('no está confirmado');

    const orderId = (
      JSON.parse(await readFile(ordersPath, 'utf8')) as Array<{ id: string }>
    )[0]?.id;
    expect(orderId).toBeDefined();
    await sendText('order-10', `/pedido estado ${orderId}`, 11);
    expect(sentMessages[10]?.text).toContain('pendiente de aprobación');
    await sendText('order-11', `/pedido aprobar ${orderId}`, 12);
    expect(sentMessages[11]?.text).toContain(
      'solo está disponible para el asesor',
    );
    await sendText(
      'order-12',
      `/pedido aprobar ${orderId}`,
      14,
      '573001112233@c.us',
    );
    expect(sentMessages[12]?.chatId).toBe('573009998877@c.us');
    expect(sentMessages[12]?.text).toContain('aprobó tu pedido');
    expect(sentMessages[13]?.text).toContain('aprobado');

    const updatedOrders = JSON.parse(
      await readFile(ordersPath, 'utf8'),
    ) as Array<{ status: string }>;
    expect(updatedOrders[0]?.status).toBe('approved');
  });

  it('validates a WhatsApp Business cart against the catalog and asks for confirmation', async () => {
    const product = {
      id: 21,
      nombre: 'Crema para manos',
      marca: 'Marca',
      categoria: 'Cuidado',
    };
    const database = {
      consultarProductos: vi.fn().mockResolvedValue([product]),
      cotizarProducto: vi.fn().mockResolvedValue({
        disponible: true,
        producto: product,
        cantidad: 2,
        subtotal: 18000,
      }),
    };
    const module = await Test.createTestingModule({
      providers: [
        WhatsAppService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, defaultValue?: string) =>
              config[key] ?? defaultValue,
          },
        },
        { provide: AiService, useValue: {} },
        { provide: DatabaseService, useValue: database },
      ],
    }).compile();
    service = module.get(WhatsAppService);

    const sentMessages: Array<{ chatId: string; text: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | Request | URL, init?: RequestInit) => {
        if (typeof init?.body !== 'string') {
          throw new Error('Expected a JSON request body.');
        }
        if (String(_input).endsWith('/chats/read')) {
          return new Response('{}', { status: 201 });
        }
        sentMessages.push(
          JSON.parse(init.body) as { chatId: string; text: string },
        );
        return new Response('{}', { status: 201 });
      }),
    );

    const chatId = '573009998877@c.us';
    const sendEvent = async (
      id: string,
      event: Record<string, unknown>,
      expectedSends: number,
    ) => {
      const body = Buffer.from(JSON.stringify(event));
      await expect(
        service.handleIncomingEvent(event, body, sign(body)),
      ).resolves.toEqual({ accepted: true });
      await vi.waitFor(() => expect(sentMessages).toHaveLength(expectedSends));
    };
    const sendText = async (id: string, text: string, expectedSends: number) =>
      sendEvent(
        id,
        {
          event: 'message.received',
          sessionId: 'test-session',
          idempotencyKey: id,
          data: {
            id,
            chatId,
            body: text,
            type: 'text',
            fromMe: false,
            isGroup: false,
            isStatusBroadcast: false,
          },
        },
        expectedSends,
      );

    await sendEvent(
      'cart-1',
      {
        event: 'message.received',
        sessionId: 'test-session',
        idempotencyKey: 'cart-1',
        data: {
          id: 'cart-message-1',
          chatId,
          type: 'order',
          fromMe: false,
          isGroup: false,
          orderMessage: {
            productItems: [
              { name: 'Crema para manos', quantity: 2, price: 999 },
            ],
          },
        },
      },
      1,
    );
    expect(sentMessages[0]?.text).toContain('$ 18.000');
    expect(database.cotizarProducto).toHaveBeenCalledWith(21, 2);

    await sendText('cart-2', 'sí', 2);
    await sendText('cart-3', 'Ana Pérez', 3);
    await sendText('cart-4', 'Calle 10 # 2-30, Bogotá', 4);
    await sendText('cart-5', 'no', 5);
    await sendText('cart-6', 'sí', 7);
    expect(sentMessages[5]?.chatId).toBe('573001112233@c.us');
    expect(sentMessages[5]?.text).toContain('Crema para manos');
    expect(sentMessages[6]?.text).toContain('no está confirmado');

    const savedOrders = JSON.parse(
      await readFile(ordersPath, 'utf8'),
    ) as Array<{ total: number; status: string }>;
    expect(savedOrders).toHaveLength(1);
    expect(savedOrders[0]).toMatchObject({
      total: 18000,
      status: 'ready_for_advisor',
    });
  });
});
