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

  it('lists products from the database when the customer asks for the catalog', async () => {
    const database = {
      consultarProductos: vi.fn().mockResolvedValue([
        { id: 1, nombre: 'Esmalte rojo', stock: 5, precio_1: 1000 },
        { id: 1, nombre: 'Esmalte rojo', stock: 2, precio_1: 1200 },
        { id: 2, nombre: 'Crema para manos', stock: 4, precio_1: 8000 },
      ]),
    };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = new AiService(database as never);

    const result = await service.responder('Muéstrame el catálogo, por favor');

    expect(result.respuesta).toContain('tengo acceso al catálogo');
    expect(result.respuesta).toContain('1. Esmalte rojo');
    expect(result.respuesta).toContain('2. Crema para manos');
    expect(result.respuesta.match(/Esmalte rojo/g)).toHaveLength(1);
    expect(result.respuesta).not.toContain('1000');
    expect(result.productosConsultados).toBe(2);
    expect(database.consultarProductos).toHaveBeenCalledWith('');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists the full catalog when the request says catalog of products', async () => {
    const database = {
      consultarProductos: vi
        .fn()
        .mockResolvedValue([{ id: 1, nombre: 'Esmalte rojo' }]),
    };
    const service = new AiService(database as never);

    await expect(
      service.responder('Muéstrame el catálogo de productos'),
    ).resolves.toMatchObject({
      respuesta: expect.stringContaining('Esmalte rojo'),
      productosConsultados: 1,
    });
    expect(database.consultarProductos).toHaveBeenCalledWith('');
  });

  it('uses the catalog search rather than listing every product for a specific category', async () => {
    const database = {
      consultarProductos: vi.fn().mockResolvedValue([
        {
          id: 5,
          nombre: 'Polvo para uñas',
          marca: 'Marca',
          categoria: 'Uñas',
        },
      ]),
    };
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== 'string') {
          throw new Error('Expected a JSON request body.');
        }
        const request = JSON.parse(init.body) as {
          messages: Array<{ role: string; content: string }>;
        };
        expect(request.messages[0]?.content).toContain(
          'Si la búsqueda no encuentra coincidencias, aclara que no encontraste productos que coincidan',
        );
        expect(request.messages[0]?.content).toContain('Polvo para uñas');
        return Response.json({
          message: { content: 'Encontré productos para uñas.' },
        });
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = new AiService(database as never);

    await expect(
      service.responder('Muéstrame el catálogo de uñas'),
    ).resolves.toMatchObject({
      respuesta: 'Encontré productos para uñas.',
      productosConsultados: 1,
    });
    expect(database.consultarProductos).toHaveBeenCalledWith('uñas');
    expect(database.consultarProductos).not.toHaveBeenCalledWith('');
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
        expect(request.messages[0]?.content).toContain(
          'Si la búsqueda no encuentra coincidencias, aclara que no encontraste productos que coincidan',
        );
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
