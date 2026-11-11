import { Test } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, vi } from 'vitest';
import { AiService } from '../ai/ai.service.js';
import { DatabaseService } from '../database/database.service.js';
import { WhatsAppService } from './whatsapp.service.js';

describe('WhatsAppService', () => {
  const secret = 'test-webhook-secret';
  let service: WhatsAppService;

  beforeEach(async () => {
    const config: Record<string, string> = {
      OPENWA_API_KEY: 'test-api-key',
      OPENWA_SESSION_ID: 'test-session',
      OPENWA_WEBHOOK_SECRET: secret,
      OPENWA_ADVISOR_PHONE: '573001112233',
    };
    const module = await Test.createTestingModule({
      providers: [
        WhatsAppService,
        {
          provide: ConfigService,
          useValue: { get: (key: string) => config[key] },
        },
        { provide: AiService, useValue: {} },
        { provide: DatabaseService, useValue: {} },
      ],
    }).compile();

    service = module.get(WhatsAppService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
    const fetchMock = vi.fn(() => sendResponse);
    vi.stubGlobal('fetch', fetchMock);

    const event = {
      event: 'message.received',
      sessionId: 'test-session',
      idempotencyKey: 'event-2',
      data: {
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

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    finishSend(new Response('{}', { status: 201 }));
    await vi.waitFor(() =>
      expect(fetchMock.mock.results[0]?.value).resolves.toBeInstanceOf(
        Response,
      ),
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
        if (url.includes('/contacts/')) {
          return Response.json({ phone: null });
        }

        if (typeof init?.body !== 'string') {
          throw new Error('Expected a JSON request body.');
        }
        const request = JSON.parse(init.body) as { chatId: string };
        expect(request.chatId).toBe('123456789@lid');
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
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('rejects incoming calls and notifies the configured advisor', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 404 }))
      .mockResolvedValueOnce(new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const event = {
      event: 'call.received',
      sessionId: 'test-session',
      idempotencyKey: 'call-1',
      data: { id: 'incoming-call-1', from: '123456789@c.us' },
    };
    const body = Buffer.from(JSON.stringify(event));

    await expect(
      service.handleIncomingEvent(event, body, sign(body)),
    ).resolves.toEqual({ accepted: true });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      '/calls/incoming-call-1/reject',
    );
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/messages/send-text');
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
      data: { id: 'incoming-call-2', from: '123456789@c.us' },
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

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'http://localhost:8000/v1/audio/transcriptions',
    );
  });
});
