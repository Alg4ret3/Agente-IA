import { AiService } from './ai.service.js';
import { afterEach, vi } from 'vitest';

describe('AiService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers greetings immediately with the LadyNail Shop advisor identity', async () => {
    const database = { consultarProductos: vi.fn() };
    const service = new AiService(database as never);

    await expect(service.responder('Hola')).resolves.toMatchObject({
      respuesta: expect.stringContaining('LadyNail Shop'),
      productosConsultados: 0,
    });
    expect(database.consultarProductos).not.toHaveBeenCalled();
  });

  it('parallelizes focused catalog searches and omits prices and stock from Ollama context', async () => {
    const database = {
      consultarProductos: vi.fn(async (term: string) =>
        term === 'esmalte'
          ? [
              {
                id: 5,
                nombre: 'Esmalte rojo',
                marca: 'Marca',
                categoria: 'Uñas',
                stock: 10,
                precio_1: 1000,
              },
            ]
          : [],
      ),
    };
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== 'string') {
          throw new Error('Expected a JSON request body.');
        }
        const request = JSON.parse(init.body) as {
          options: { num_predict: number; temperature: number };
          messages: Array<{ role: string; content: string }>;
        };
        expect(request.options).toEqual({ temperature: 0.2, num_predict: 128 });
        expect(request.messages[0]?.content).toContain(
          'asesora virtual de LadyNail Shop',
        );
        expect(request.messages[0]?.content).not.toContain('precio_1');
        expect(request.messages[0]?.content).not.toContain('"stock"');
        return Response.json({
          message: { content: 'Puedo ayudarte a cotizar.' },
        });
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = new AiService(database as never);

    await expect(
      service.responder('¿Tienen esmalte rojo?'),
    ).resolves.toMatchObject({
      respuesta: 'Puedo ayudarte a cotizar.',
      productosConsultados: 1,
    });
    expect(database.consultarProductos).toHaveBeenCalledTimes(2);
    expect(database.consultarProductos).not.toHaveBeenCalledWith('');
  });
});
